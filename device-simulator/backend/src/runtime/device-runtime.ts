import { MqttClient } from 'mqtt';
import { createDeviceMqttClient } from '../infrastructure/mqtt/client';
import { DeviceState, generateInitialState, evolveState } from '../generation/telemetry-generator';
import { getMongoDb } from '../infrastructure/mongodb/client';
import { getCachedCatalog } from '../catalog/loader';
import crypto from 'crypto';
import pino from 'pino';

export class DeviceRuntime {
    private mac: string;
    private productId: string;
    private mqttClient: MqttClient | null = null;
    private state: DeviceState;
    private seq: number = 0;
    private intervalMs: number;
    private timer: NodeJS.Timeout | null = null;
    private isPaused: boolean = false;
    private logger: pino.Logger;

    constructor(mac: string, productId: string, intervalMs: number, initialSeq: number, logger: pino.Logger) {
        this.mac = mac;
        this.productId = productId;
        this.intervalMs = intervalMs;
        this.seq = initialSeq;
        this.logger = logger.child({ mac });
        
        // Find product to generate correct initial state
        const catalog = getCachedCatalog();
        const product = catalog.find(p => p.id === productId) || { id: productId, display_name: 'Unknown', category: 'unknown', capabilities: [] };
        
        this.state = generateInitialState(product);
    }

    async connect() {
        if (this.mqttClient) return;

        this.mqttClient = createDeviceMqttClient(this.mac);

        this.mqttClient.on('connect', () => {
            this.logger.info('MQTT Connected');
            this.updateRuntimeState('online');
            
            // Subscribe to control topics
            this.mqttClient?.subscribe(`smarthome/${this.mac}/control`, { qos: 1 });
            
            this.startTelemetry();
        });

        this.mqttClient.on('message', (topic, payload) => {
            if (topic === `smarthome/${this.mac}/control`) {
                this.handleCommand(payload);
            }
        });

        this.mqttClient.on('error', (err) => {
            this.logger.error({ err }, 'MQTT Error');
            this.updateRuntimeState('mqtt_error');
        });
        
        this.mqttClient.on('offline', () => {
            this.logger.warn('MQTT Offline');
            this.updateRuntimeState('offline');
            this.stopTelemetry();
        });
    }

    disconnect() {
        this.stopTelemetry();
        if (this.mqttClient) {
            this.mqttClient.end();
            this.mqttClient = null;
        }
        this.updateRuntimeState('offline');
    }

    pause() {
        this.isPaused = true;
    }

    resume() {
        this.isPaused = false;
    }

    private startTelemetry() {
        if (this.timer) clearInterval(this.timer);
        
        // Add jitter: randomize the start of the interval by up to intervalMs
        const jitter = Math.random() * this.intervalMs;
        
        setTimeout(() => {
            // First immediate publish
            this.publishTelemetry();
            
            // Then loop
            this.timer = setInterval(() => {
                if (!this.isPaused) {
                    this.publishTelemetry();
                }
            }, this.intervalMs);
        }, jitter);
    }

    private stopTelemetry() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    private async publishTelemetry() {
        if (!this.mqttClient || !this.mqttClient.connected) return;

        this.seq++;
        
        const catalog = getCachedCatalog();
        const product = catalog.find(p => p.id === this.productId) || { id: this.productId, display_name: 'Unknown', category: 'unknown', capabilities: [] };
        
        this.state = evolveState(this.state, product);

        const payload = {
            device_id: this.mac,
            timestamp: new Date().toISOString(),
            seq: this.seq,
            metrics: this.state.metrics,
            ...this.state.diagnostics,
            trace_id: crypto.randomUUID()
        };

        const topic = `smarthome/${this.mac}/telemetry`;
        this.mqttClient.publish(topic, JSON.stringify(payload), { qos: 1 }, (err) => {
            if (err) {
                this.logger.error({ err }, 'Failed to publish telemetry');
            }
        });

        // Save seq to Registry
        const db = getMongoDb();
        await db.collection('simulated_devices').updateOne(
            { mac: this.mac },
            { $set: { seq: this.seq, last_telemetry: new Date() } }
        );
    }

    private async handleCommand(rawPayload: Buffer) {
        try {
            const command = JSON.parse(rawPayload.toString());
            this.logger.info({ action: command.action }, 'Received command');

            // Naive state mutation
            if (command.action === 'SET_BRIGHTNESS' && typeof command.payload?.brightness === 'number') {
                this.state.metrics['brightness'] = command.payload.brightness;
            } else if (command.action === 'SET_SWITCH' && typeof command.payload?.power === 'boolean') {
                this.state.metrics['power'] = command.payload.power;
            }

            // Send ACK
            const ackTopic = `smarthome/${this.mac}/ack`;
            const ackPayload = {
                command_id: command.command_id,
                device_id: this.mac,
                status: 'success'
            };
            this.mqttClient?.publish(ackTopic, JSON.stringify(ackPayload), { qos: 1 });

            // Force immediate telemetry to reflect new state
            this.publishTelemetry();
            
        } catch (err) {
            this.logger.error({ err }, 'Error processing command');
        }
    }

    private async updateRuntimeState(state: string) {
        const db = getMongoDb();
        await db.collection('simulated_devices').updateOne(
            { mac: this.mac },
            { $set: { runtime_state: state, updated_at: new Date() } }
        );
    }
}
