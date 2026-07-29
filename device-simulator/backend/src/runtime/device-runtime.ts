import crypto from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { MqttClient } from 'mqtt';
import { getProduct } from '../catalog/loader';
import { env } from '../config/env';
import type {
    SimulatedDeviceRecord,
    TransportMode,
} from '../domain/registry';
import { recordSimulatorEvent } from '../events/service';
import {
    type DeviceCommand,
    parseDeviceCommand,
} from '../generation/command-validation';
import {
    applyCommandToState,
    type DeviceState,
    evolveState,
    generateInitialState,
    patchDeviceState,
} from '../generation/telemetry-generator';
import { getMongoDb } from '../infrastructure/mongodb/client';
import {
    createDeviceMqttClient,
    resolveMqttTopic,
} from '../infrastructure/mqtt/client';
import { getRunMetricsService } from '../metrics/service';
import { startupDelayMs } from './scheduling';
import { getTelemetryScheduler } from './telemetry-scheduler';
import {
    commandRouteMatchesAssignment,
    shouldApplyAssignment,
    type CommandRoute,
    type TopologyAssignment,
} from './topology';

export type BrokerMessageKind = 'telemetry' | 'ack' | 'status';

export interface RuntimeTransportCoordinator {
    isRelayAvailable(device: DeviceRuntime): boolean;
    publishDeviceMessage(
        device: DeviceRuntime,
        kind: BrokerMessageKind,
        payload: Record<string, unknown>,
        commandRoute?: CommandRoute,
    ): Promise<void>;
    deliverRelayedCommand(hubMac: string, rawPayload: Buffer): Promise<void>;
    onBrokerAvailable(device: DeviceRuntime): void;
    onBrokerUnavailable(device: DeviceRuntime): void;
}

interface CommandResult {
    status: 'success' | 'error';
    errorMessage?: string;
    expiresAt: number;
}

export class DeviceRuntime {
    private mqttClient: MqttClient | null = null;
    private state: DeviceState;
    private seq: number;
    private isPaused = false;
    private desiredOnline = false;
    private isPublishing = false;
    private connectPromise: Promise<void> | null = null;
    private lastRegistrySyncAt = 0;
    private lastTelemetryAt: Date | null = null;
    private assignment?: TopologyAssignment;
    private directFallbackOverride = false;
    private lastTopologyAckKey: string | null = null;
    private readonly commandResults = new Map<string, CommandResult>();
    private readonly logger: FastifyBaseLogger;

    constructor(
        private readonly simulationRunId: string,
        private readonly mac: string,
        private readonly productId: string,
        private readonly intervalMs: number,
        private readonly telemetryJitterPercent: number,
        private readonly startupRampMs: number,
        initialSeq: number,
        logger: FastifyBaseLogger,
        private readonly transportCoordinator: RuntimeTransportCoordinator,
        initialState?: DeviceState,
        initialAssignment?: TopologyAssignment,
    ) {
        this.seq = initialSeq;
        this.logger = logger.child({ mac, productId });
        this.state = initialState || generateInitialState(getProduct(productId));
        this.assignment = initialAssignment;
    }

    get id(): string {
        return this.mac;
    }

    get connected(): boolean {
        if (!this.desiredOnline) return false;
        return this.effectiveTransportMode === 'relay'
            ? this.transportCoordinator.isRelayAvailable(this)
            : Boolean(this.mqttClient?.connected);
    }

    get brokerConnected(): boolean {
        return Boolean(this.mqttClient?.connected);
    }

    get runId(): string {
        return this.simulationRunId;
    }

    get paused(): boolean {
        return this.isPaused;
    }

    get topology(): TopologyAssignment | undefined {
        return this.assignment;
    }

    get effectiveTransportMode(): TransportMode | 'direct' {
        if (!this.assignment) return 'direct';
        if (
            this.assignment.role === 'node'
            && (
                this.directFallbackOverride
                || this.assignment.transport_mode === 'direct_fallback'
            )
        ) {
            return 'direct_fallback';
        }
        return this.assignment.transport_mode;
    }

    async connect(): Promise<void> {
        this.desiredOnline = true;
        await this.reconcileTransport();
    }

    async disconnect(): Promise<void> {
        const wasOperational = this.connected;
        this.desiredOnline = false;
        this.stopTelemetry();
        if (wasOperational) {
            await this.publishStatus('offline').catch((error) => {
                this.logger.warn({ err: error }, 'Could not publish virtual device offline status');
            });
        }
        await this.persistRegistryState(this.lastTelemetryAt || new Date(), true);
        await this.releaseBrokerConnection();
        this.transportCoordinator.onBrokerUnavailable(this);
        await this.updateRuntimeState('offline');
    }

    async pause(): Promise<void> {
        this.isPaused = true;
        this.stopTelemetry();
        await this.persistRegistryState(this.lastTelemetryAt || new Date(), true);
        await this.updateRuntimeState('paused');
    }

    async resume(): Promise<void> {
        this.isPaused = false;
        if (!this.desiredOnline) this.desiredOnline = true;
        await this.reconcileTransport();
    }

    async publishNow(): Promise<void> {
        if (!this.connected) throw new Error('Virtual device transport is unavailable');
        await this.publishTelemetry(false);
    }

    async resetState(): Promise<DeviceState> {
        this.state = generateInitialState(getProduct(this.productId));
        await this.persistRegistryState(new Date(), true);
        if (this.connected) await this.publishTelemetry(false);
        return this.state;
    }

    async patchState(patch: Partial<DeviceState>): Promise<DeviceState> {
        this.state = patchDeviceState(this.state, getProduct(this.productId), patch);
        await this.persistRegistryState(new Date(), true);
        if (this.connected) await this.publishTelemetry(false);
        return this.state;
    }

    async applyTopologyAssignment(incoming: TopologyAssignment): Promise<boolean> {
        if (!shouldApplyAssignment(this.assignment, incoming)) return false;
        this.assignment = incoming;
        this.directFallbackOverride = false;
        this.lastTopologyAckKey = null;

        await getMongoDb().collection<SimulatedDeviceRecord>('simulated_devices').updateOne(
            { mac: this.mac },
            {
                $set: {
                    network_id: incoming.network_id,
                    join_rank: incoming.join_rank,
                    topology_role: incoming.role,
                    topology_epoch: incoming.topology_epoch,
                    topology_state: incoming.topology_state,
                    active_hub_mac: incoming.active_hub_mac,
                    transport_mode: incoming.transport_mode,
                    updated_at: new Date(),
                },
            },
        );

        if (this.desiredOnline) await this.reconcileTransport();
        await recordSimulatorEvent({
            type: 'device.topology_assigned',
            severity: 'info',
            run_id: this.simulationRunId,
            mac: this.mac,
            message: `Applied ${incoming.role} assignment for topology epoch ${incoming.topology_epoch}`,
            data: {
                network_id: incoming.network_id,
                topology_epoch: incoming.topology_epoch,
                topology_state: incoming.topology_state,
                role: incoming.role,
                transport_mode: incoming.transport_mode,
                active_hub_mac: incoming.active_hub_mac,
            },
        }).catch(() => undefined);
        return true;
    }

    async activateDirectFallback(): Promise<void> {
        if (!this.assignment || this.assignment.role !== 'node') return;
        if (this.directFallbackOverride) return;
        this.directFallbackOverride = true;
        await getMongoDb().collection<SimulatedDeviceRecord>('simulated_devices').updateOne(
            { mac: this.mac },
            {
                $set: {
                    transport_mode: 'direct_fallback',
                    updated_at: new Date(),
                },
            },
        );
        if (this.desiredOnline) await this.reconcileTransport();
        await recordSimulatorEvent({
            type: 'device.direct_fallback',
            severity: 'warning',
            run_id: this.simulationRunId,
            mac: this.mac,
            message: 'Node switched to direct MQTT fallback because its Hub is unavailable',
            data: {
                network_id: this.assignment.network_id,
                topology_epoch: this.assignment.topology_epoch,
                active_hub_mac: this.assignment.active_hub_mac,
            },
        }).catch(() => undefined);
    }

    async receiveCommand(rawPayload: Buffer, originMac: string): Promise<void> {
        await this.handleCommand(rawPayload, originMac.trim().toUpperCase());
    }

    async publishBrokerMessage(
        kind: BrokerMessageKind | 'topology_ack',
        payload: Record<string, unknown>,
    ): Promise<void> {
        if (!this.mqttClient?.connected) {
            throw new Error(`MQTT transport for ${this.mac} is unavailable`);
        }
        const topicTemplate = kind === 'telemetry'
            ? env.MQTT_TELEMETRY_TOPIC
            : kind === 'ack'
                ? env.MQTT_ACK_TOPIC
                : kind === 'status'
                    ? env.MQTT_STATUS_TOPIC
                    : env.MQTT_TOPOLOGY_ACK_TOPIC;
        const topic = resolveMqttTopic(topicTemplate, this.mac);
        await new Promise<void>((resolve, reject) => {
            this.mqttClient?.publish(
                topic,
                JSON.stringify(payload),
                { qos: 1 },
                (error) => error ? reject(error) : resolve(),
            );
        });
    }

    private requiresBrokerConnection(): boolean {
        return this.effectiveTransportMode !== 'relay';
    }

    private async reconcileTransport(): Promise<void> {
        if (!this.desiredOnline) return;
        if (
            this.assignment?.transport_mode === 'relay'
            && !this.directFallbackOverride
            && !this.transportCoordinator.isRelayAvailable(this)
        ) {
            await this.activateDirectFallback();
            return;
        }
        if (this.requiresBrokerConnection()) {
            await this.ensureBrokerConnection();
            await this.refreshSubscriptions();
        } else {
            await this.releaseBrokerConnection();
        }

        if (this.connected) {
            await this.updateRuntimeState(this.isPaused ? 'paused' : 'online');
            if (!this.isPaused) this.startTelemetry();
            await this.publishStatus('online').catch((error) => {
                this.logger.warn({ err: error }, 'Could not publish virtual device online status');
            });
            await this.publishTopologyReadyAck();
        } else {
            this.stopTelemetry();
            await this.updateRuntimeState('offline');
        }
    }

    private async ensureBrokerConnection(): Promise<void> {
        if (this.mqttClient?.connected) return;
        if (this.connectPromise) return this.connectPromise;

        this.connectPromise = new Promise<void>((resolve, reject) => {
            const client = createDeviceMqttClient(this.mac);
            this.mqttClient = client;
            void this.updateRuntimeState('connecting');

            const onInitialError = (error: Error) => {
                client.off('connect', onInitialConnect);
                client.end(true);
                if (this.mqttClient === client) this.mqttClient = null;
                this.connectPromise = null;
                reject(error);
            };
            const onInitialConnect = () => {
                client.off('error', onInitialError);
                this.connectPromise = null;
                resolve();
            };
            client.once('error', onInitialError);
            client.once('connect', onInitialConnect);

            client.on('connect', () => {
                this.logger.info(
                    { transportMode: this.effectiveTransportMode },
                    'Virtual device broker transport connected',
                );
                getRunMetricsService(this.logger).record(this.simulationRunId, {
                    mqtt_connects: 1,
                });
                this.transportCoordinator.onBrokerAvailable(this);
                void this.refreshSubscriptions()
                    .then(() => this.reconcileTransport())
                    .catch((error) => this.logger.error(
                        { err: error },
                        'Failed to reconcile virtual device after MQTT connect',
                    ));
            });

            client.on('message', (topic, payload) => {
                if (topic === this.controlTopic()) {
                    void this.handleCommand(payload, this.mac);
                } else if (topic === this.hubControlTopic()) {
                    void this.transportCoordinator
                        .deliverRelayedCommand(this.mac, payload)
                        .catch((error) => this.logger.warn(
                            { err: error },
                            'Hub rejected a relayed command',
                        ));
                }
            });

            client.on('error', (error) => {
                this.logger.error({ err: error }, 'Virtual device MQTT error');
                getRunMetricsService(this.logger).record(this.simulationRunId, {
                    mqtt_errors: 1,
                });
                void this.updateRuntimeState('mqtt_error');
            });

            client.on('offline', () => {
                this.logger.warn('Virtual device broker transport is offline');
                getRunMetricsService(this.logger).record(this.simulationRunId, {
                    mqtt_disconnects: 1,
                });
                void this.updateRuntimeState('offline');
                if (this.assignment?.role === 'hub') {
                    this.transportCoordinator.onBrokerUnavailable(this);
                }
            });
        });

        return this.connectPromise;
    }

    private async releaseBrokerConnection(): Promise<void> {
        const client = this.mqttClient;
        this.mqttClient = null;
        this.connectPromise = null;
        if (!client) return;
        await new Promise<void>((resolve, reject) => {
            client.end(false, {}, (error) => error ? reject(error) : resolve());
        });
        getRunMetricsService(this.logger).record(this.simulationRunId, {
            mqtt_disconnects: 1,
        });
    }

    private async refreshSubscriptions(): Promise<void> {
        const client = this.mqttClient;
        if (!client?.connected) return;
        const desiredTopics = [this.controlTopic()];
        if (this.assignment?.role === 'hub') desiredTopics.push(this.hubControlTopic());
        await new Promise<void>((resolve, reject) => {
            client.subscribe(desiredTopics, { qos: 1 }, (error) => (
                error ? reject(error) : resolve()
            ));
        });
        if (this.assignment?.role !== 'hub') {
            await new Promise<void>((resolve) => {
                client.unsubscribe(this.hubControlTopic(), () => resolve());
            });
        }
    }

    private controlTopic(): string {
        return resolveMqttTopic(env.MQTT_CONTROL_TOPIC, this.mac);
    }

    private hubControlTopic(): string {
        return resolveMqttTopic(env.MQTT_HUB_CONTROL_TOPIC, this.mac);
    }

    private startTelemetry(): void {
        getTelemetryScheduler().register({
            deviceId: this.mac,
            runId: this.simulationRunId,
            intervalMs: this.intervalMs,
            jitterPercent: this.telemetryJitterPercent,
            initialDelayMs: startupDelayMs(this.startupRampMs, this.intervalMs),
            publish: async () => {
                if (!this.isPaused && this.connected) {
                    await this.publishTelemetry(true);
                }
            },
        });
    }

    private stopTelemetry(): void {
        getTelemetryScheduler().unregister(this.mac);
    }

    private async publishTelemetry(evolve: boolean): Promise<void> {
        if (!this.connected || this.isPublishing) return;
        this.isPublishing = true;
        try {
            const product = getProduct(this.productId);
            if (evolve) this.state = evolveState(this.state, product);
            const nextSeq = await this.reserveNextSequence();
            const timestamp = new Date();
            const payload = {
                device_id: this.mac,
                timestamp: timestamp.toISOString(),
                seq: nextSeq,
                metrics: {
                    ...this.state.metrics,
                    ...this.state.diagnostics,
                },
                trace_id: crypto.randomUUID(),
            };
            const serializedPayload = JSON.stringify(payload);
            await this.transportCoordinator.publishDeviceMessage(this, 'telemetry', payload);

            this.lastTelemetryAt = timestamp;
            getRunMetricsService(this.logger).record(this.simulationRunId, {
                telemetry_published: 1,
                telemetry_bytes: Buffer.byteLength(serializedPayload),
            });
            await this.persistRegistryState(timestamp);
        } catch (error) {
            this.logger.error({ err: error }, 'Failed to publish virtual device telemetry');
            getRunMetricsService(this.logger).record(this.simulationRunId, {
                telemetry_failed: 1,
            });
        } finally {
            this.isPublishing = false;
        }
    }

    private async handleCommand(rawPayload: Buffer, originMac: string): Promise<void> {
        let command: DeviceCommand | null = null;
        let routeValidated = false;
        let commandApplied = false;
        getRunMetricsService(this.logger).record(this.simulationRunId, {
            commands_received: 1,
        });
        try {
            const parsed = JSON.parse(rawPayload.toString()) as unknown;
            command = parseDeviceCommand(parsed);
            if (command.target_device_id && command.target_device_id !== this.mac) {
                throw new Error('Command target does not match this virtual device');
            }
            if (
                command.route
                && !commandRouteMatchesAssignment(
                    command.route,
                    this.assignment,
                    this.mac,
                    this.effectiveTransportMode === 'direct'
                        ? undefined
                        : this.effectiveTransportMode,
                )
            ) {
                throw new Error('Command route does not match the current topology assignment');
            }
            if (
                command.route?.mode === 'relay'
                && originMac !== this.assignment?.active_hub_mac
            ) {
                throw new Error('Relayed command did not originate from the active Hub');
            }
            if (
                command.route
                && command.route.mode !== 'relay'
                && originMac !== this.mac
            ) {
                throw new Error('Direct command origin does not match this device');
            }
            routeValidated = true;

            const previous = this.getCommandResult(command.command_id);
            if (previous) {
                await this.publishAck(
                    command.command_id,
                    previous.status,
                    command.route,
                    previous.errorMessage,
                );
                return;
            }

            this.state = applyCommandToState(this.state, getProduct(this.productId), command);
            this.storeCommandResult(command.command_id, { status: 'success' });
            commandApplied = true;
            getRunMetricsService(this.logger).record(this.simulationRunId, {
                commands_applied: 1,
            });
            await this.publishAck(command.command_id, 'success', command.route);
            await recordSimulatorEvent({
                type: 'device.command',
                severity: 'info',
                run_id: this.simulationRunId,
                mac: this.mac,
                message: `Applied command ${command.action}`,
                data: {
                    command_id: command.command_id,
                    capability_id: command.capability_id,
                    instance: command.instance,
                    action: command.action,
                    payload: command.payload,
                    route: command.route,
                },
            });
            await this.publishTelemetry(false);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (commandApplied && command?.command_id) {
                this.logger.warn(
                    { err: error, commandId: command.command_id },
                    'Command was applied but its success ACK could not be published',
                );
                await recordSimulatorEvent({
                    type: 'device.command_ack_failed',
                    severity: 'warning',
                    run_id: this.simulationRunId,
                    mac: this.mac,
                    message: 'Command was applied but its success ACK could not be published',
                    data: {
                        command_id: command.command_id,
                        action: command.action,
                        error: message,
                    },
                }).catch(() => undefined);
                return;
            }
            this.logger.warn({ err: error }, 'Rejected virtual device command');
            getRunMetricsService(this.logger).record(this.simulationRunId, {
                commands_rejected: 1,
            });
            if (command?.command_id && routeValidated) {
                this.storeCommandResult(command.command_id, {
                    status: 'error',
                    errorMessage: message,
                });
                try {
                    await this.publishAck(
                        command.command_id,
                        'error',
                        command.route,
                        message,
                    );
                } catch (ackError) {
                    this.logger.warn(
                        { err: ackError, commandId: command.command_id },
                        'Could not publish rejection ACK',
                    );
                }
            }
            await recordSimulatorEvent({
                type: 'device.command_failed',
                severity: 'warning',
                run_id: this.simulationRunId,
                mac: this.mac,
                message: 'Virtual device rejected a command',
                data: {
                    command_id: command?.command_id,
                    action: command?.action,
                    error: message,
                },
            }).catch(() => undefined);
        }
    }

    private async publishAck(
        commandId: string,
        status: 'success' | 'error',
        route?: CommandRoute,
        errorMessage?: string,
    ): Promise<void> {
        const payload = {
            command_id: commandId,
            device_id: this.mac,
            status,
            ...(errorMessage ? { error_msg: errorMessage.slice(0, 500) } : {}),
        };
        try {
            await this.transportCoordinator.publishDeviceMessage(
                this,
                'ack',
                payload,
                route,
            );
            getRunMetricsService(this.logger).record(this.simulationRunId, {
                acks_published: 1,
            });
        } catch (error) {
            getRunMetricsService(this.logger).record(this.simulationRunId, {
                acks_failed: 1,
            });
            throw error;
        }
    }

    private async publishStatus(status: 'online' | 'offline' | 'heartbeat'): Promise<void> {
        await this.transportCoordinator.publishDeviceMessage(this, 'status', {
            device_id: this.mac,
            status,
            timestamp: new Date().toISOString(),
        });
    }

    private async publishTopologyReadyAck(): Promise<void> {
        const assignment = this.assignment;
        if (
            !assignment
            || assignment.role !== 'hub'
            || assignment.topology_state !== 'electing'
            || !this.mqttClient?.connected
        ) {
            return;
        }
        const ackKey = `${assignment.network_id}:${assignment.topology_epoch}`;
        if (this.lastTopologyAckKey === ackKey) return;
        await this.publishBrokerMessage('topology_ack', {
            device_id: this.mac,
            network_id: assignment.network_id,
            topology_epoch: assignment.topology_epoch,
            status: 'ready',
            timestamp: new Date().toISOString(),
        });
        this.lastTopologyAckKey = ackKey;
    }

    private getCommandResult(commandId: string): CommandResult | undefined {
        const result = this.commandResults.get(commandId);
        if (!result) return undefined;
        if (result.expiresAt <= Date.now()) {
            this.commandResults.delete(commandId);
            return undefined;
        }
        return result;
    }

    private storeCommandResult(
        commandId: string,
        result: Omit<CommandResult, 'expiresAt'>,
    ): void {
        const now = Date.now();
        for (const [id, existing] of this.commandResults) {
            if (existing.expiresAt <= now) this.commandResults.delete(id);
        }
        while (this.commandResults.size >= 1000) {
            const oldest = this.commandResults.keys().next().value as string | undefined;
            if (!oldest) break;
            this.commandResults.delete(oldest);
        }
        this.commandResults.set(commandId, {
            ...result,
            expiresAt: now + env.COMMAND_DEDUP_TTL_MS,
        });
    }

    private async persistRegistryState(timestamp: Date, force = false): Promise<void> {
        const now = Date.now();
        if (!force && now - this.lastRegistrySyncAt < env.REGISTRY_STATE_FLUSH_INTERVAL_MS) {
            return;
        }
        await getMongoDb().collection<SimulatedDeviceRecord>('simulated_devices').updateOne(
            { mac: this.mac },
            {
                $set: {
                    state_snapshot: this.state,
                    ...(this.lastTelemetryAt ? { last_telemetry: this.lastTelemetryAt } : {}),
                    runtime_state: this.isPaused
                        ? 'paused'
                        : this.connected ? 'online' : 'offline',
                    transport_mode: this.effectiveTransportMode === 'direct'
                        ? undefined
                        : this.effectiveTransportMode,
                    updated_at: timestamp,
                },
            },
        );
        this.lastRegistrySyncAt = now;
    }

    private async reserveNextSequence(): Promise<number> {
        const updated = await getMongoDb()
            .collection<SimulatedDeviceRecord>('simulated_devices')
            .findOneAndUpdate(
                { mac: this.mac },
                {
                    $inc: { seq: 1 },
                    $set: { updated_at: new Date() },
                },
                {
                    returnDocument: 'after',
                    projection: { seq: 1 },
                },
            );
        if (!updated || !Number.isSafeInteger(updated.seq)) {
            throw new Error(`Could not reserve telemetry sequence for ${this.mac}`);
        }
        this.seq = updated.seq;
        return this.seq;
    }

    private async updateRuntimeState(
        state: SimulatedDeviceRecord['runtime_state'],
    ): Promise<void> {
        await getMongoDb().collection<SimulatedDeviceRecord>('simulated_devices').updateOne(
            { mac: this.mac },
            { $set: { runtime_state: state, updated_at: new Date() } },
        );
    }

    async refreshTransportAvailability(): Promise<void> {
        if (
            this.assignment?.transport_mode === 'relay'
            && this.directFallbackOverride
            && this.transportCoordinator.isRelayAvailable(this)
        ) {
            this.directFallbackOverride = false;
            await getMongoDb().collection<SimulatedDeviceRecord>('simulated_devices').updateOne(
                { mac: this.mac },
                {
                    $set: {
                        transport_mode: 'relay',
                        updated_at: new Date(),
                    },
                },
            );
        }
        if (this.desiredOnline) await this.reconcileTransport();
    }
}
