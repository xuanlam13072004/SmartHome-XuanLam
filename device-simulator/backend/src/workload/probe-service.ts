import type { FastifyBaseLogger } from 'fastify';
import { getCachedCatalog } from '../catalog/loader';
import { env } from '../config/env';
import type { SimulatedDeviceRecord, SimulatedUserRecord } from '../domain/registry';
import { apiGateway } from '../infrastructure/api-gateway/client';
import { getMongoDb } from '../infrastructure/mongodb/client';
import { getRunMetricsService } from '../metrics/service';
import { getRuntimeManager } from '../runtime/manager';
import { accessTokenFor } from '../security/user-session';
import {
    pickProbeCommand,
    type ProbeDeps,
    type ProbeKind,
    type ProbeParams,
    type ProbeResult,
    ProbeRun,
    type ProbeUser,
} from './probe';

/**
 * Runs one probe at a time with the simulator's own users, keeps the live one
 * in memory and the last results in the simulator database (`load_probes`).
 */

const COLLECTION = 'load_probes';
const KEEP_RESULTS = 50;

export class ProbeService {
    private current: ProbeRun | null = null;

    constructor(private readonly log: FastifyBaseLogger) {}

    get running(): ProbeRun | null {
        return this.current && ['preparing', 'running'].includes(this.current.result.status) ? this.current : null;
    }

    start(params: ProbeParams): ProbeResult {
        if (this.running) throw Object.assign(new Error('Một bài đo đang chạy.'), { statusCode: 409 });
        const run = new ProbeRun(this.deps(), params);
        this.current = run;
        void run.run()
            .then(result => this.save(result))
            .catch(error => this.log.error({ error }, 'Load probe failed'));
        return run.result;
    }

    stop(id: string): boolean {
        if (this.current?.result.id !== id || !this.running) return false;
        this.current.cancel();
        return true;
    }

    /** The live probe (summary refreshed), if any. */
    live(): ProbeResult | null {
        if (!this.current) return null;
        if (this.running) this.current.refresh();
        return this.current.result;
    }

    async list(): Promise<ProbeResult[]> {
        return getMongoDb().collection<ProbeResult>(COLLECTION)
            .find({}, { projection: { _id: 0, samples: 0 } })
            .sort({ started_at: -1 })
            .limit(KEEP_RESULTS)
            .toArray() as Promise<ProbeResult[]>;
    }

    async get(id: string): Promise<ProbeResult | null> {
        if (this.current?.result.id === id) return this.live();
        return getMongoDb().collection<ProbeResult>(COLLECTION).findOne({ id }, { projection: { _id: 0 } });
    }

    private async save(result: ProbeResult) {
        const collection = getMongoDb().collection<ProbeResult>(COLLECTION);
        await collection.insertOne({ ...result });
        const old = await collection.find({}, { projection: { id: 1 } }).sort({ started_at: -1 }).skip(KEEP_RESULTS).toArray();
        if (old.length > 0) await collection.deleteMany({ id: { $in: old.map(item => item.id) } });
    }

    private deps(): ProbeDeps {
        return {
            users: (kind, limit) => this.users(kind, limit),
            accessToken: async (accountId) => {
                const token = await accessTokenFor(accountId);
                if (!token) throw new Error('Simulated user not found');
                return token;
            },
            request: async (path, init) => {
                const response = await fetch(`${env.API_GATEWAY_URL.replace(/\/$/, '')}${path}`, {
                    method: init.method,
                    headers: {
                        authorization: `Bearer ${init.token}`,
                        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
                    },
                    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
                    signal: AbortSignal.timeout(env.API_REQUEST_TIMEOUT_MS),
                });
                return { status: response.status, body: await response.json().catch(() => null) };
            },
            operation: (token, mac, id) => apiGateway.deviceOperation(token, mac, id),
            context: () => {
                const runtime = getRuntimeManager(this.log).getGlobalStats();
                return {
                    devices_connected: runtime.connected,
                    devices_registered: runtime.registered,
                    telemetry_per_second: getRunMetricsService(this.log).globalRates().telemetry_per_second,
                };
            },
            now: () => Date.now(),
            sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
        };
    }

    /** Users with an online device that has a safe command (commands), or any ready user (reads). */
    private async users(kind: ProbeKind, limit: number): Promise<ProbeUser[]> {
        const db = getMongoDb();
        if (kind === 'app_reads') {
            const users = await db.collection<SimulatedUserRecord>('simulated_users')
                .find({ status: 'active', generation_state: 'ready', account_id: { $exists: true } }, { projection: { account_id: 1 } })
                .limit(limit)
                .toArray();
            return users.map(user => ({ account_id: user.account_id!, devices: [] }));
        }
        const products = new Map(getCachedCatalog().map(product => [product.product_id, product]));
        const groups = await db.collection<SimulatedDeviceRecord>('simulated_devices').aggregate<{
            _id: string; devices: Array<{ mac: string; product_id: string }>;
        }>([
            { $match: { runtime_state: 'online', origin: { $ne: 'factory' }, simulator_user_id: { $nin: ['', null] } } },
            { $group: { _id: '$simulator_user_id', devices: { $push: { mac: '$mac', product_id: '$product_id' } } } },
            { $sort: { _id: 1 } },
            { $limit: limit * 2 },
        ]).toArray();
        const users: ProbeUser[] = [];
        for (const group of groups) {
            const devices = group.devices.flatMap(device => {
                const product = products.get(device.product_id);
                const command = product ? pickProbeCommand(product.operations as any) : null;
                return command ? [{ mac: device.mac, command }] : [];
            });
            if (devices.length > 0) users.push({ account_id: group._id, devices });
            if (users.length >= limit) break;
        }
        return users;
    }
}

let instance: ProbeService | null = null;

export const getProbeService = (log: FastifyBaseLogger): ProbeService => {
    instance ??= new ProbeService(log);
    return instance;
};
