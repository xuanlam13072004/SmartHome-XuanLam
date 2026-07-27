import crypto from 'node:crypto';
import type { MqttClient } from 'mqtt';
import type { FastifyBaseLogger } from 'fastify';
import { env } from '../config/env';
import {
    createDeviceMqttClient,
    resolveMqttTopic,
} from '../infrastructure/mqtt/client';
import {
    applyCommandToState,
    type DeviceState,
    evolveState,
    generateInitialState,
    patchDeviceState,
} from '../generation/telemetry-generator';
import { getMongoDb } from '../infrastructure/mongodb/client';
import { getProduct } from '../catalog/loader';
import type { SimulatedDeviceRecord } from '../domain/registry';
import { recordSimulatorEvent } from '../events/service';
import { getRunMetricsService } from '../metrics/service';
import {
    startupDelayMs,
} from './scheduling';
import { getTelemetryScheduler } from './telemetry-scheduler';
import {
    type DeviceCommand,
    parseDeviceCommand,
} from '../generation/command-validation';

export class DeviceRuntime {
    private mqttClient: MqttClient | null = null;
    private state: DeviceState;
    private seq: number;
    private isPaused = false;
    private isPublishing = false;
    private connectPromise: Promise<void> | null = null;
    private lastRegistrySyncAt = 0;
    private lastTelemetryAt: Date | null = null;
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
        initialState?: DeviceState,
    ) {
        this.seq = initialSeq;
        this.logger = logger.child({ mac, productId });
        this.state = initialState || generateInitialState(getProduct(productId));
    }

    get connected(): boolean {
        return Boolean(this.mqttClient?.connected);
    }

    get runId(): string {
        return this.simulationRunId;
    }

    get paused(): boolean {
        return this.isPaused;
    }

    async connect(): Promise<void> {
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
                this.logger.info('Virtual device connected to MQTT');
                getRunMetricsService(this.logger).record(this.simulationRunId, {
                    mqtt_connects: 1,
                });
                void this.updateRuntimeState('online');
                client.subscribe(this.controlTopic(), { qos: 1 }, (error) => {
                    if (error) {
                        this.logger.error({ err: error }, 'Failed to subscribe to device control topic');
                        return;
                    }
                    this.startTelemetry();
                });
            });

            client.on('message', (topic, payload) => {
                if (topic === this.controlTopic()) {
                    void this.handleCommand(payload);
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
                this.logger.warn('Virtual device MQTT connection is offline');
                getRunMetricsService(this.logger).record(this.simulationRunId, {
                    mqtt_disconnects: 1,
                });
                void this.updateRuntimeState('offline');
                this.stopTelemetry();
            });

            client.on('close', () => {
                this.stopTelemetry();
            });
        });

        return this.connectPromise;
    }

    async disconnect(): Promise<void> {
        this.stopTelemetry();
        await this.persistRegistryState(this.lastTelemetryAt || new Date(), true);
        const client = this.mqttClient;
        this.mqttClient = null;
        this.connectPromise = null;
        if (client) {
            await new Promise<void>((resolve, reject) => {
                client.end(false, {}, (error) => error ? reject(error) : resolve());
            });
            getRunMetricsService(this.logger).record(this.simulationRunId, {
                mqtt_disconnects: 1,
            });
        }
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
        if (this.mqttClient?.connected) {
            await this.updateRuntimeState('online');
            this.startTelemetry();
        }
    }

    async publishNow(): Promise<void> {
        await this.publishTelemetry(false);
    }

    async resetState(): Promise<DeviceState> {
        this.state = generateInitialState(getProduct(this.productId));
        await this.persistRegistryState(new Date(), true);
        if (this.mqttClient?.connected) await this.publishTelemetry(false);
        return this.state;
    }

    async patchState(patch: Partial<DeviceState>): Promise<DeviceState> {
        this.state = patchDeviceState(this.state, getProduct(this.productId), patch);
        await this.persistRegistryState(new Date(), true);
        if (this.mqttClient?.connected) await this.publishTelemetry(false);
        return this.state;
    }

    private controlTopic(): string {
        return resolveMqttTopic(env.MQTT_CONTROL_TOPIC, this.mac);
    }

    private startTelemetry(): void {
        getTelemetryScheduler().register({
            deviceId: this.mac,
            runId: this.simulationRunId,
            intervalMs: this.intervalMs,
            jitterPercent: this.telemetryJitterPercent,
            initialDelayMs: startupDelayMs(this.startupRampMs, this.intervalMs),
            publish: async () => {
                if (!this.isPaused && this.mqttClient?.connected) {
                    await this.publishTelemetry(true);
                }
            },
        });
    }

    private stopTelemetry(): void {
        getTelemetryScheduler().unregister(this.mac);
    }

    private async publishTelemetry(evolve: boolean): Promise<void> {
        if (!this.mqttClient?.connected || this.isPublishing) return;
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

            await new Promise<void>((resolve, reject) => {
                this.mqttClient?.publish(
                    resolveMqttTopic(env.MQTT_TELEMETRY_TOPIC, this.mac),
                    serializedPayload,
                    { qos: 1 },
                    (error) => error ? reject(error) : resolve(),
                );
            });

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

    private async handleCommand(rawPayload: Buffer): Promise<void> {
        let command: DeviceCommand | null = null;
        getRunMetricsService(this.logger).record(this.simulationRunId, {
            commands_received: 1,
        });
        try {
            const parsed = JSON.parse(rawPayload.toString()) as unknown;
            if (
                parsed
                && typeof parsed === 'object'
                && !Array.isArray(parsed)
                && typeof (parsed as Record<string, unknown>).command_id === 'string'
            ) {
                command = {
                    command_id: (parsed as Record<string, unknown>).command_id as string,
                    action: typeof (parsed as Record<string, unknown>).action === 'string'
                        ? (parsed as Record<string, unknown>).action as string
                        : '',
                    payload: {},
                };
            }
            command = parseDeviceCommand(parsed);

            this.state = applyCommandToState(this.state, getProduct(this.productId), command);
            await this.publishAck(command.command_id, 'success');
            getRunMetricsService(this.logger).record(this.simulationRunId, {
                commands_applied: 1,
            });
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
                },
            });
            await this.publishTelemetry(false);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn({ err: error }, 'Rejected virtual device command');
            getRunMetricsService(this.logger).record(this.simulationRunId, {
                commands_rejected: 1,
            });
            if (command?.command_id) {
                try {
                    await this.publishAck(command.command_id, 'error', message);
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
        errorMessage?: string,
    ): Promise<void> {
        if (!this.mqttClient?.connected) {
            throw new Error('MQTT client disconnected before ACK');
        }
        const payload = {
            command_id: commandId,
            device_id: this.mac,
            status,
            ...(errorMessage ? { error_msg: errorMessage.slice(0, 500) } : {}),
        };
        try {
            await new Promise<void>((resolve, reject) => {
                this.mqttClient?.publish(
                    resolveMqttTopic(env.MQTT_ACK_TOPIC, this.mac),
                    JSON.stringify(payload),
                    { qos: 1 },
                    (error) => error ? reject(error) : resolve(),
                );
            });
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
                        : this.mqttClient?.connected ? 'online' : 'offline',
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
}
