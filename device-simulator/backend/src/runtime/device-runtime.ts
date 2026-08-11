import crypto from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { MqttClient } from 'mqtt';
import type { ProductCatalog } from '../catalog/loader';
import { env } from '../config/env';
import type {
    SimulatedDeviceRecord,
    TransportMode,
} from '../domain/registry';
import { recordSimulatorEvent } from '../events/service';
import {
    type DeviceOperation,
    parseDeviceOperation,
} from '../generation/operation-validation';
import {
    applyOperationToState,
    type DeviceState,
    type DeviceStatePatch,
    evolveState,
    generateInitialState,
    patchDeviceState,
    removeCatalogConstants,
} from '../generation/telemetry-generator';
import { getMongoDb } from '../infrastructure/mongodb/client';
import {
    createDeviceMqttClient,
    resolveMqttTopic,
} from '../infrastructure/mqtt/client';
import { getRunMetricsService } from '../metrics/service';
import { decrypt } from '../security/crypto';
import { startupDelayMs } from './scheduling';
import { getTelemetryScheduler } from './telemetry-scheduler';
import {
    registerPresenceHeartbeat,
    unregisterPresenceHeartbeat,
} from './presence-heartbeat-scheduler';
import {
    automaticRainClosePlan,
    beginRoofMotion,
    completeRoofMotion,
    normalizeRoofMotionState,
    pendingRoofMotionFromState,
    roofMotionPlanForOperation,
    SIMULATED_ROOF_MOTION_DURATION_MS,
    type RoofMotionPlan,
} from './roof-motion';
import {
    operationRouteMatchesAssignment,
    shouldApplyAssignment,
    type OperationRoute,
    type TopologyAssignment,
} from './topology';

export type BrokerMessageKind = 'telemetry' | 'operation_ack' | 'presence';

export interface RuntimeTransportCoordinator {
    isRelayAvailable(device: DeviceRuntime): boolean;
    publishDeviceMessage(
        device: DeviceRuntime,
        kind: BrokerMessageKind,
        payload: Record<string, unknown>,
        operationRoute?: OperationRoute,
    ): Promise<void>;
    deliverRelayedOperation(hubMac: string, rawPayload: Buffer): Promise<void>;
    onBrokerAvailable(device: DeviceRuntime): void;
    onBrokerUnavailable(device: DeviceRuntime): void;
}

interface OperationResult {
    status: 'succeeded' | 'rejected';
    reasonCode?: string;
    details?: Record<string, unknown>;
    expiresAt: number;
}

export class DeviceRuntime {
    private mqttClient: MqttClient | null = null;
    private state: DeviceState;
    private seq: number;
    private isPaused = false;
    private desiredOnline = false;
    private isPublishing = false;
    private pendingImmediateTelemetry = false;
    private connectPromise: Promise<void> | null = null;
    private lastRegistrySyncAt = 0;
    private lastTelemetryAt: Date | null = null;
    private assignment?: TopologyAssignment;
    private directFallbackOverride = false;
    private lastTopologyAckKey: string | null = null;
    private roofMotionTimer: NodeJS.Timeout | null = null;
    private disposed = false;
    private stateMutationQueue: Promise<void> = Promise.resolve();
    private readonly operationResults = new Map<string, OperationResult>();
    private readonly logger: FastifyBaseLogger;

    constructor(
        private readonly simulationRunId: string,
        private readonly mac: string,
        private readonly product: ProductCatalog,
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
        this.logger = logger.child({
            mac,
            productId: product.product_id,
            catalogRevision: product.catalog_revision,
        });
        this.state = normalizeRoofMotionState(initialState
            ? removeCatalogConstants(initialState, product)
            : generateInitialState(product), product);
        this.assignment = initialAssignment;
        this.resumeRoofMotionFromState();
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
        if (this.disposed) throw new Error('Virtual device runtime has been disposed');
        this.desiredOnline = true;
        this.resumeRoofMotionFromState();
        await this.reconcileTransport();
    }

    async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;
        this.cancelRoofMotion();
        await this.stateMutationQueue.catch(() => undefined);
        await this.disconnect();
    }

    async disconnect(): Promise<void> {
        const wasOperational = this.connected;
        this.desiredOnline = false;
        this.stopTelemetry();
        this.stopPresenceHeartbeat();
        if (wasOperational) {
            await this.publishPresence('offline').catch((error) => {
                this.logger.warn({ err: error }, 'Could not publish virtual device offline status');
            });
        }
        this.setOnlineDiagnostic(false);
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
        if (this.disposed) throw new Error('Virtual device runtime has been disposed');
        this.isPaused = false;
        if (!this.desiredOnline) this.desiredOnline = true;
        this.resumeRoofMotionFromState();
        await this.reconcileTransport();
    }

    async publishNow(): Promise<void> {
        if (!this.connected) throw new Error('Virtual device transport is unavailable');
        await this.serializeStateMutation(() => this.publishTelemetry(false));
    }

    async resetState(): Promise<DeviceState> {
        return this.serializeStateMutation(async () => {
            this.cancelRoofMotion();
            const next = generateInitialState(this.product);
            next.state_version = this.state.state_version + 1;
            this.state = next;
            await this.persistRegistryState(new Date(), true);
            if (this.connected) await this.publishTelemetry(false);
            return this.state;
        });
    }

    async patchState(patch: DeviceStatePatch): Promise<DeviceState> {
        return this.serializeStateMutation(async () => {
            const product = this.product;
            this.state = patchDeviceState(this.state, product, patch);
            const movementWasPatched = product.capability_instances.some(instance => (
                instance.capability_id === 'cover_controller'
                && Object.prototype.hasOwnProperty.call(
                    patch.instances?.[instance.instance_id]?.reported || {},
                    'movement',
                )
            ));
            if (movementWasPatched) {
                this.cancelRoofMotion();
                this.resumeRoofMotionFromState();
            }
            const automaticClose = automaticRainClosePlan(product, this.state);
            if (!movementWasPatched && automaticClose?.shouldMove) {
                this.state = beginRoofMotion(this.state, automaticClose);
                this.scheduleRoofMotion(automaticClose);
            }
            await this.persistRegistryState(new Date(), true);
            if (this.connected) await this.publishTelemetry(false);
            return this.state;
        });
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

    async receiveOperation(rawPayload: Buffer, originMac: string): Promise<void> {
        if (this.disposed) throw new Error('Virtual device runtime has been disposed');
        await this.serializeStateMutation(() => this.handleControlMessage(
            rawPayload,
            originMac.trim().toUpperCase(),
        ));
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
            : kind === 'operation_ack'
                ? env.MQTT_ACK_TOPIC
                : kind === 'presence'
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
            this.startPresenceHeartbeat();
            if (!this.isPaused) this.startTelemetry();
            await this.publishPresence('online').catch((error) => {
                this.logger.warn({ err: error }, 'Could not publish virtual device online status');
            });
            await this.publishTopologyReadyAck();
        } else {
            this.stopTelemetry();
            this.stopPresenceHeartbeat();
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
                if (this.disposed) return;
                if (topic === this.controlTopic()) {
                    void this.serializeStateMutation(
                        () => this.handleControlMessage(payload, this.mac),
                    );
                } else if (topic === this.hubControlTopic()) {
                    void this.transportCoordinator
                        .deliverRelayedOperation(this.mac, payload)
                        .catch((error) => this.logger.warn(
                            { err: error },
                            'Hub rejected a relayed operation',
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
                this.stopPresenceHeartbeat();
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
                    await this.serializeStateMutation(() => this.publishTelemetry(true));
                }
            },
        });
    }

    private stopTelemetry(): void {
        getTelemetryScheduler().unregister(this.mac);
    }

    private startPresenceHeartbeat(): void {
        registerPresenceHeartbeat(this.mac, this.simulationRunId, async () => {
            if (!this.connected) return;
            await this.publishPresence('heartbeat');
        });
    }

    private stopPresenceHeartbeat(): void {
        unregisterPresenceHeartbeat(this.mac);
    }

    private setOnlineDiagnostic(online: boolean): void {
        const system = this.state.diagnostics.system;
        if (!system || system.online === online) return;
        system.online = online;
        this.state.state_version += 1;
    }

    private async publishTelemetry(evolve: boolean): Promise<void> {
        if (!this.connected) return;
        if (this.isPublishing) {
            // A physical state change, operation or credential update must not
            // disappear when it overlaps the scheduler's in-flight publish.
            // Coalesce repeated immediate requests; the follow-up packet reads
            // the latest complete state after the current packet finishes.
            if (!evolve) this.pendingImmediateTelemetry = true;
            return;
        }
        this.isPublishing = true;
        try {
            const product = this.product;
            if (evolve) this.state = evolveState(this.state, product);
            this.setOnlineDiagnostic(true);
            const nextSeq = await this.reserveNextSequence();
            const timestamp = new Date();
            const instances = Object.fromEntries(
                Object.entries(this.state.instances).map(([instanceId, envelope]) => [
                    instanceId,
                    { reported: envelope.reported },
                ]),
            );
            const payload = {
                schema: 'device.telemetry.v2',
                event_id: `${this.mac}:${nextSeq}`,
                device_id: this.mac,
                product_id: product.product_id,
                catalog_revision: product.catalog_revision,
                state_version: this.state.state_version,
                seq: nextSeq,
                observed_at: timestamp.toISOString(),
                instances,
                diagnostics: this.state.diagnostics,
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
            if (this.pendingImmediateTelemetry) {
                this.pendingImmediateTelemetry = false;
                await this.publishTelemetry(false);
            }
        }
    }

    private async handleOperation(rawPayload: Buffer, originMac: string): Promise<void> {
        let operation: DeviceOperation | null = null;
        let routeValidated = false;
        let operationApplied = false;
        getRunMetricsService(this.logger).record(this.simulationRunId, {
            operations_received: 1,
        });
        try {
            operation = parseDeviceOperation(JSON.parse(rawPayload.toString()) as unknown);
            const product = this.product;
            if (operation.target_device_id !== this.mac) {
                throw new Error('Operation target does not match this virtual device');
            }
            if (
                operation.product_id !== product.product_id
                || operation.catalog_revision !== product.catalog_revision
            ) {
                throw new Error('Operation Product contract does not match device firmware');
            }
            if (!operationRouteMatchesAssignment(
                operation.route,
                this.assignment,
                this.mac,
                this.effectiveTransportMode === 'direct'
                    ? undefined
                    : this.effectiveTransportMode,
            )) {
                throw new Error('Operation route does not match the current topology assignment');
            }
            if (operation.route.mode === 'relay' && originMac !== this.assignment?.active_hub_mac) {
                throw new Error('Relayed operation did not originate from the active Hub');
            }
            if (operation.route.mode !== 'relay' && originMac !== this.mac) {
                throw new Error('Direct operation origin does not match this device');
            }
            routeValidated = true;

            const previous = this.getOperationResult(operation.operation_id);
            if (previous) {
                await this.publishOperationAck(
                    operation.operation_id,
                    previous.status,
                    operation.route,
                    previous.reasonCode,
                    previous.details,
                );
                return;
            }

            const roofMotion = roofMotionPlanForOperation(product, operation, this.state);
            const rainProtection = automaticRainClosePlan(product, this.state);
            if (roofMotion?.movingState === 'opening' && rainProtection) {
                throw new Error('Automatic rain protection prevents opening the roof');
            }
            this.state = applyOperationToState(this.state, product, operation);
            if (roofMotion && !roofMotion.shouldMove) {
                // Repeating an already-satisfied idempotent command must not make
                // the virtual roof appear to move again.
                this.state = completeRoofMotion(this.state, roofMotion);
            }
            let scheduledMotion = roofMotion;
            const automaticClose = automaticRainClosePlan(product, this.state);
            if (!roofMotion && automaticClose?.shouldMove) {
                this.state = beginRoofMotion(this.state, automaticClose);
                scheduledMotion = automaticClose;
            }
            await this.persistRegistryState(new Date(), true);
            if (scheduledMotion) this.scheduleRoofMotion(scheduledMotion);
            const resourceId = typeof operation.context.resource_id === 'string'
                ? operation.context.resource_id
                : null;
            const resourceSessionId = typeof operation.context.resource_session_id === 'string'
                ? operation.context.resource_session_id
                : null;
            const details = resourceId && resourceSessionId
                ? {
                    resource_locator: `simulator://device/${this.mac}/resource/${resourceId}/${resourceSessionId}`,
                }
                : undefined;
            this.storeOperationResult(operation.operation_id, { status: 'succeeded', details });
            operationApplied = true;
            getRunMetricsService(this.logger).record(this.simulationRunId, {
                operations_applied: 1,
            });
            await this.publishOperationAck(
                operation.operation_id,
                'succeeded',
                operation.route,
                undefined,
                details,
            );
            await recordSimulatorEvent({
                type: 'device.operation_applied',
                severity: 'info',
                run_id: this.simulationRunId,
                mac: this.mac,
                message: `Applied operation ${operation.operation_name}`,
                data: {
                    operation_id: operation.operation_id,
                    instance_id: operation.instance_id,
                    operation_name: operation.operation_name,
                    input: operation.input,
                    route: operation.route,
                },
            });
            await this.publishTelemetry(false);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (operationApplied && operation) {
                this.logger.warn(
                    { err: error, operationId: operation.operation_id },
                    'Operation was applied but its success ACK could not be published',
                );
                await recordSimulatorEvent({
                    type: 'device.operation_ack_failed',
                    severity: 'warning',
                    run_id: this.simulationRunId,
                    mac: this.mac,
                    message: 'Operation was applied but its success ACK could not be published',
                    data: {
                        operation_id: operation.operation_id,
                        operation_name: operation.operation_name,
                        error: message,
                    },
                }).catch(() => undefined);
                return;
            }

            this.logger.warn({ err: error }, 'Rejected virtual device operation');
            getRunMetricsService(this.logger).record(this.simulationRunId, {
                operations_rejected: 1,
            });
            if (operation && routeValidated) {
                const reasonCode = 'DEVICE_OPERATION_REJECTED';
                const details = { message: message.slice(0, 500) };
                this.storeOperationResult(operation.operation_id, {
                    status: 'rejected',
                    reasonCode,
                    details,
                });
                try {
                    await this.publishOperationAck(
                        operation.operation_id,
                        'rejected',
                        operation.route,
                        reasonCode,
                        details,
                    );
                } catch (ackError) {
                    this.logger.warn(
                        { err: ackError, operationId: operation.operation_id },
                        'Could not publish operation rejection ACK',
                    );
                }
            }
            await recordSimulatorEvent({
                type: 'device.operation_rejected',
                severity: 'warning',
                run_id: this.simulationRunId,
                mac: this.mac,
                message: 'Virtual device rejected an operation',
                data: {
                    operation_id: operation?.operation_id,
                    operation_name: operation?.operation_name,
                    error: message,
                },
            }).catch(() => undefined);
        }
    }

    private async handleControlMessage(rawPayload: Buffer, originMac: string): Promise<void> {
        let message: unknown;
        try {
            message = JSON.parse(rawPayload.toString());
        } catch {
            this.logger.warn('Rejected control payload that is not valid JSON');
            return;
        }
        if (
            message
            && typeof message === 'object'
            && !Array.isArray(message)
            && (message as Record<string, unknown>).schema === 'device.credential.v2'
        ) {
            await this.handleCredential(message as Record<string, unknown>, originMac);
            return;
        }
        await this.handleOperation(rawPayload, originMac);
    }

    private async handleCredential(
        message: Record<string, unknown>,
        originMac: string,
    ): Promise<void> {
        const jobId = String(message.job_id || '');
        const route = message.route as OperationRoute;
        let routeValidated = false;
        try {
            if (!/^[0-9a-f-]{36}$/i.test(jobId)) throw new Error('Credential job ID is invalid');
            const target = String(message.target_device_id || '').trim().toUpperCase();
            const instanceId = String(message.instance_id || '');
            const credentialName = String(message.credential_name || '');
            if (target !== this.mac) throw new Error('Credential target does not match device');
            if (!/^[a-z][a-z0-9_]+$/.test(instanceId) || !/^[a-z][a-z0-9_]+$/.test(credentialName)) {
                throw new Error('Credential identity is invalid');
            }
            if (!operationRouteMatchesAssignment(
                route,
                this.assignment,
                this.mac,
                this.effectiveTransportMode === 'direct'
                    ? undefined
                    : this.effectiveTransportMode,
            )) {
                throw new Error('Credential route does not match topology');
            }
            if (route.mode === 'relay' && originMac !== this.assignment?.active_hub_mac) {
                throw new Error('Relayed credential did not originate from active Hub');
            }
            if (route.mode !== 'relay' && originMac !== this.mac) {
                throw new Error('Direct credential origin does not match device');
            }
            routeValidated = true;
            const envelope = message.encrypted_envelope as Record<string, unknown>;
            if (
                !envelope
                || envelope.algorithm !== 'RSA-OAEP-256+A256GCM'
                || typeof envelope.encrypted_key_base64 !== 'string'
                || typeof envelope.iv_base64 !== 'string'
                || typeof envelope.ciphertext_base64 !== 'string'
                || typeof envelope.auth_tag_base64 !== 'string'
            ) {
                throw new Error('Credential envelope is invalid');
            }
            const registry = await getMongoDb().collection<SimulatedDeviceRecord>('simulated_devices')
                .findOne({ mac: this.mac });
            if (!registry?.credential_private_key) throw new Error('Device credential key is unavailable');
            const privateKey = decrypt(
                registry.credential_private_key.iv,
                registry.credential_private_key.encrypted,
                registry.credential_private_key.authTag,
            );
            const envelopeKey = crypto.privateDecrypt(
                {
                    key: privateKey,
                    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
                    oaepHash: 'sha256',
                },
                Buffer.from(envelope.encrypted_key_base64, 'base64'),
            );
            const envelopeDecipher = crypto.createDecipheriv(
                'aes-256-gcm',
                envelopeKey,
                Buffer.from(envelope.iv_base64, 'base64'),
            );
            envelopeDecipher.setAuthTag(Buffer.from(envelope.auth_tag_base64, 'base64'));
            const decryptedPayload = Buffer.concat([
                envelopeDecipher.update(Buffer.from(envelope.ciphertext_base64, 'base64')),
                envelopeDecipher.final(),
            ]).toString('utf8');
            const material = JSON.parse(decryptedPayload) as Record<string, unknown>;
            if (
                material.job_id !== jobId
                || material.instance_id !== instanceId
                || material.credential_name !== credentialName
                || typeof material.material !== 'string'
            ) {
                throw new Error('Credential envelope content is inconsistent');
            }
            const digest = crypto.createHash('sha256').update(material.material).digest('hex');
            const digestPath = `secure_credential_digests.${instanceId}.${credentialName}`;
            await getMongoDb().collection<SimulatedDeviceRecord>('simulated_devices').updateOne(
                { mac: this.mac },
                { $set: { [digestPath]: digest, updated_at: new Date() } },
            );
            const reported = this.state.instances[instanceId]?.reported;
            const configuredProperty = `${credentialName}_configured`;
            if (reported && Object.prototype.hasOwnProperty.call(reported, configuredProperty)) {
                reported[configuredProperty] = true;
                await this.persistRegistryState(new Date(), true);
            }
            await this.publishCredentialAck(jobId, 'succeeded', route);
            await this.publishTelemetry(false);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            this.logger.warn({ err: error, jobId }, 'Rejected virtual device credential');
            if (routeValidated) {
                await this.publishCredentialAck(
                    jobId,
                    'rejected',
                    route,
                    'DEVICE_CREDENTIAL_REJECTED',
                ).catch(() => undefined);
            }
            await recordSimulatorEvent({
                type: 'device.credential_rejected',
                severity: 'warning',
                run_id: this.simulationRunId,
                mac: this.mac,
                message: 'Virtual device rejected a credential envelope',
                data: { job_id: jobId, error: reason.slice(0, 500) },
            }).catch(() => undefined);
        }
    }

    private async publishCredentialAck(
        jobId: string,
        status: 'succeeded' | 'rejected',
        route: OperationRoute,
        reasonCode?: string,
    ): Promise<void> {
        await this.transportCoordinator.publishDeviceMessage(
            this,
            'operation_ack',
            {
                schema: 'device.credential.ack.v2',
                job_id: jobId,
                device_id: this.mac,
                status,
                observed_at: new Date().toISOString(),
                ...(reasonCode ? { reason_code: reasonCode } : {}),
            },
            route,
        );
    }

    private async publishOperationAck(
        operationId: string,
        status: 'succeeded' | 'rejected',
        route: OperationRoute,
        reasonCode?: string,
        details?: Record<string, unknown>,
    ): Promise<void> {
        const payload = {
            schema: 'device.operation.ack.v2',
            operation_id: operationId,
            device_id: this.mac,
            status,
            observed_at: new Date().toISOString(),
            ...(reasonCode ? { reason_code: reasonCode } : {}),
            ...(details ? { details } : {}),
        };
        try {
            await this.transportCoordinator.publishDeviceMessage(
                this,
                'operation_ack',
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

    private async publishPresence(status: 'online' | 'offline' | 'heartbeat'): Promise<void> {
        await this.transportCoordinator.publishDeviceMessage(this, 'presence', {
            schema: 'device.presence.v2',
            device_id: this.mac,
            product_id: this.product.product_id,
            catalog_revision: this.product.catalog_revision,
            status,
            observed_at: new Date().toISOString(),
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
            schema: 'device.topology.ack.v2',
            device_id: this.mac,
            network_id: assignment.network_id,
            topology_epoch: assignment.topology_epoch,
            status: 'ready',
            observed_at: new Date().toISOString(),
        });
        this.lastTopologyAckKey = ackKey;
    }

    private getOperationResult(operationId: string): OperationResult | undefined {
        const result = this.operationResults.get(operationId);
        if (!result) return undefined;
        if (result.expiresAt <= Date.now()) {
            this.operationResults.delete(operationId);
            return undefined;
        }
        return result;
    }

    private storeOperationResult(
        operationId: string,
        result: Omit<OperationResult, 'expiresAt'>,
    ): void {
        const now = Date.now();
        for (const [id, existing] of this.operationResults) {
            if (existing.expiresAt <= now) this.operationResults.delete(id);
        }
        while (this.operationResults.size >= 1000) {
            const oldest = this.operationResults.keys().next().value as string | undefined;
            if (!oldest) break;
            this.operationResults.delete(oldest);
        }
        this.operationResults.set(operationId, {
            ...result,
            expiresAt: now + env.OPERATION_DEDUP_TTL_MS,
        });
    }

    private cancelRoofMotion(): void {
        if (!this.roofMotionTimer) return;
        clearTimeout(this.roofMotionTimer);
        this.roofMotionTimer = null;
    }

    private resumeRoofMotionFromState(): void {
        if (this.disposed || this.roofMotionTimer) return;
        const plan = pendingRoofMotionFromState(this.product, this.state);
        if (plan) this.scheduleRoofMotion(plan);
    }

    private scheduleRoofMotion(plan?: RoofMotionPlan): void {
        if (!plan) return;
        this.cancelRoofMotion();
        if (!plan.shouldMove || this.disposed) return;
        this.roofMotionTimer = setTimeout(() => {
            this.roofMotionTimer = null;
            void this.serializeStateMutation(() => this.completeScheduledRoofMotion(plan));
        }, SIMULATED_ROOF_MOTION_DURATION_MS);
        this.roofMotionTimer.unref();
    }

    private async completeScheduledRoofMotion(plan: RoofMotionPlan): Promise<void> {
        if (this.disposed) return;
        const next = completeRoofMotion(this.state, plan);
        if (next === this.state) return;
        this.state = next;
        try {
            await this.persistRegistryState(new Date(), true);
            if (!this.isPaused && this.connected) await this.publishTelemetry(false);
            await recordSimulatorEvent({
                type: 'device.roof_motion_completed',
                severity: 'info',
                run_id: this.simulationRunId,
                mac: this.mac,
                message: `Virtual roof reached ${plan.finalState}`,
                data: {
                    instance_id: plan.instanceId,
                    movement: plan.finalState,
                    duration_ms: SIMULATED_ROOF_MOTION_DURATION_MS,
                },
            }).catch((error) => this.logger.warn(
                { err: error, finalState: plan.finalState },
                'Could not record virtual roof completion event',
            ));
        } catch (error) {
            this.logger.error(
                { err: error, finalState: plan.finalState },
                'Failed to persist completed virtual roof motion',
            );
        }
    }

    private serializeStateMutation<T>(action: () => Promise<T>): Promise<T> {
        const result = this.stateMutationQueue.then(action, action);
        this.stateMutationQueue = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
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
