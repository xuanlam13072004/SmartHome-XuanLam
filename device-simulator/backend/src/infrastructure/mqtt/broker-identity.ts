import crypto from 'node:crypto';
import type { MqttClient } from 'mqtt';
import { env } from '../../config/env';
import { createFactoryMqttClient } from './client';

/**
 * Registers and revokes the broker identities of virtual devices through the
 * Mosquitto Dynamic Security API, exactly as a factory does for physical
 * devices (docs/architecture/mqtt-security.md).
 *
 * Requests are batched: the plugin rewrites its whole JSON file once per
 * control message, which costs ~150 ms of broker time at 30,000 clients.
 */

export const DEVICE_ROLE = 'smarthome-device';
const CONTROL_TOPIC = '$CONTROL/dynamic-security/v1';
const RESPONSE_TOPIC = `${CONTROL_TOPIC}/response`;
const MAX_COMMANDS_PER_MESSAGE = 200;
const RESPONSE_TIMEOUT_MS = 15_000;

export interface DynsecCommand {
    command: string;
    [field: string]: unknown;
}

export interface DynsecResponse {
    command: string;
    error?: string;
    data?: unknown;
}

export type DynsecTransport = (commands: DynsecCommand[]) => Promise<DynsecResponse[]>;

type QueuedRequest = {
    kind: 'ensure' | 'revoke';
    mac: string;
    password?: string;
    resolve: () => void;
    reject: (error: Error) => void;
};

const deviceRoles = [{ rolename: DEVICE_ROLE, priority: 0 }];

export class BrokerIdentityRegistry {
    private queue: QueuedRequest[] = [];
    private timer: NodeJS.Timeout | null = null;
    private flushing: Promise<void> | null = null;

    constructor(
        private readonly transport: DynsecTransport,
        private readonly batchWindowMs = env.MQTT_IDENTITY_BATCH_MS,
    ) {}

    /** Creates the device identity, or re-keys it if it already exists. */
    ensureDeviceIdentity(mac: string, password: string): Promise<void> {
        return this.enqueue({ kind: 'ensure', mac, password });
    }

    /** Deletes the device identity; the broker also disconnects its session. */
    revokeDeviceIdentity(mac: string): Promise<void> {
        return this.enqueue({ kind: 'revoke', mac });
    }

    private enqueue(request: Omit<QueuedRequest, 'resolve' | 'reject'>): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            this.queue.push({ ...request, mac: request.mac.trim().toUpperCase(), resolve, reject });
            if (this.queue.length >= MAX_COMMANDS_PER_MESSAGE) {
                this.scheduleFlush(0);
            } else {
                this.scheduleFlush(this.batchWindowMs);
            }
        });
    }

    private scheduleFlush(delayMs: number): void {
        if (this.timer && delayMs > 0) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.flush();
        }, delayMs);
    }

    async flush(): Promise<void> {
        while (this.flushing) await this.flushing;
        if (this.queue.length === 0) return;
        const batch = this.queue.splice(0, MAX_COMMANDS_PER_MESSAGE);
        this.flushing = this.process(batch).finally(() => {
            this.flushing = null;
            if (this.queue.length > 0) this.scheduleFlush(0);
        });
        await this.flushing;
    }

    private async process(batch: QueuedRequest[]): Promise<void> {
        try {
            const responses = await this.transport(batch.map(request => (
                request.kind === 'ensure'
                    ? { command: 'createClient', username: request.mac, password: request.password, roles: deviceRoles }
                    : { command: 'deleteClient', username: request.mac }
            )));
            const rekey: QueuedRequest[] = [];
            batch.forEach((request, index) => {
                const error = responses[index]?.error;
                if (!responses[index]) {
                    request.reject(new Error('Dynamic Security returned no response'));
                } else if (!error || (request.kind === 'revoke' && error === 'Client not found')) {
                    request.resolve();
                } else if (request.kind === 'ensure' && error === 'Client already exists') {
                    rekey.push(request);
                } else {
                    request.reject(new Error(`Dynamic Security rejected ${request.mac}: ${error}`));
                }
            });
            if (rekey.length === 0) return;
            const updated = await this.transport(rekey.map(request => ({
                command: 'modifyClient',
                username: request.mac,
                password: request.password,
                roles: deviceRoles,
            })));
            rekey.forEach((request, index) => {
                const error = updated[index]?.error;
                if (updated[index] && !error) request.resolve();
                else request.reject(new Error(`Dynamic Security rejected ${request.mac}: ${error || 'no response'}`));
            });
        } catch (error) {
            for (const request of batch) request.reject(error as Error);
        }
    }
}

/** Transport over the factory's MQTT connection, correlating responses by id. */
export class MqttDynsecTransport {
    private client: MqttClient | null = null;
    private ready: Promise<MqttClient> | null = null;
    private readonly pending = new Map<string, { resolve: (value: DynsecResponse[]) => void; timer: NodeJS.Timeout }>();

    readonly send: DynsecTransport = async (commands) => {
        const client = await this.connect();
        const correlation = crypto.randomUUID();
        const tagged = commands.map((command, index) => ({
            ...command,
            correlationData: index === 0 ? correlation : `${correlation}:${index}`,
        }));
        const responses = new Promise<DynsecResponse[]>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(correlation);
                reject(new Error('Dynamic Security did not respond; check MQTT_FACTORY_* credentials'));
            }, RESPONSE_TIMEOUT_MS);
            this.pending.set(correlation, { resolve, timer });
        });
        await client.publishAsync(CONTROL_TOPIC, JSON.stringify({ commands: tagged }), { qos: 1 });
        return responses;
    };

    private connect(): Promise<MqttClient> {
        if (this.client?.connected) return Promise.resolve(this.client);
        if (this.ready) return this.ready;
        this.ready = new Promise<MqttClient>((resolve, reject) => {
            const client = createFactoryMqttClient(`device-simulator-factory-${process.pid}`);
            client.on('message', (topic, payload) => this.onResponse(topic, payload));
            client.on('connect', () => {
                client.subscribe(RESPONSE_TOPIC, { qos: 1 }, (error) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    this.client = client;
                    resolve(client);
                });
            });
            client.once('error', (error) => {
                this.ready = null;
                client.end(true);
                reject(error);
            });
        });
        return this.ready;
    }

    private onResponse(topic: string, payload: Buffer): void {
        if (topic !== RESPONSE_TOPIC) return;
        let parsed: { responses?: Array<DynsecResponse & { correlationData?: string }> };
        try {
            parsed = JSON.parse(payload.toString());
        } catch {
            return;
        }
        const responses = Array.isArray(parsed.responses) ? parsed.responses : [];
        const correlation = responses[0]?.correlationData;
        const pending = correlation ? this.pending.get(correlation) : undefined;
        if (!pending || !correlation) return;
        this.pending.delete(correlation);
        clearTimeout(pending.timer);
        pending.resolve(responses);
    }

    async close(): Promise<void> {
        for (const pending of this.pending.values()) clearTimeout(pending.timer);
        this.pending.clear();
        const client = this.client;
        this.client = null;
        this.ready = null;
        if (client) await client.endAsync();
    }
}

let transport: MqttDynsecTransport | null = null;
let registry: BrokerIdentityRegistry | null = null;

export const getBrokerIdentityRegistry = (): BrokerIdentityRegistry => {
    if (!registry) {
        transport = new MqttDynsecTransport();
        registry = new BrokerIdentityRegistry(transport.send);
    }
    return registry;
};

export const closeBrokerIdentityRegistry = async (): Promise<void> => {
    await registry?.flush().catch(() => undefined);
    await transport?.close();
    transport = null;
    registry = null;
};

export const generateDeviceMqttPassword = (): string => crypto.randomBytes(32).toString('base64url');
