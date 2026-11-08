import type { AnyBulkWriteOperation, Db } from 'mongodb';
import type { SimulatedDeviceRecord } from '../domain/registry';
import { env } from '../config/env';
import { getMongoDb } from '../infrastructure/mongodb/client';

type DeviceFields = Partial<Pick<
    SimulatedDeviceRecord,
    'state_snapshot' | 'irrigation_session' | 'last_telemetry' | 'runtime_state' | 'transport_mode' | 'updated_at'
>> & Record<string, unknown>;

const BULK_CHUNK = 1000;

/**
 * Write-behind cache for the fast-changing registry fields of running devices
 * (state snapshot, runtime state, last telemetry). Telemetry no longer costs a
 * MongoDB round trip per message: changes are merged per device and written
 * with unordered `bulkWrite` batches. Manual actions use `writeNow`, which
 * includes anything still pending so a later batch never overwrites newer data.
 */
export class RegistryWriter {
    private pending = new Map<string, DeviceFields>();
    private inFlight: Promise<void> = Promise.resolve();
    private timer: NodeJS.Timeout | null = null;

    constructor(
        private readonly registryDb: () => Db = getMongoDb,
        private readonly intervalMs = env.REGISTRY_STATE_FLUSH_INTERVAL_MS,
    ) {}

    get pendingCount(): number {
        return this.pending.size;
    }

    /** Merges fields into the device's next batched write. */
    defer(mac: string, fields: DeviceFields): void {
        const current = this.pending.get(mac);
        this.pending.set(mac, current ? Object.assign(current, fields) : { ...fields });
        this.ensureTimer();
    }

    /** Writes the device now, together with its pending fields. */
    async writeNow(mac: string, fields: DeviceFields = {}): Promise<void> {
        const merged = { ...(this.pending.get(mac) || {}), ...fields };
        this.pending.delete(mac);
        await this.inFlight.catch(() => undefined);
        if (Object.keys(merged).length === 0) return;
        await this.collection().updateOne({ mac }, { $set: stripUndefined(merged) });
    }

    /** Writes everything pending; batches are serialized. */
    flush(): Promise<void> {
        const batch = this.pending;
        if (batch.size === 0) return this.inFlight;
        this.pending = new Map();
        const run = this.inFlight.catch(() => undefined).then(async () => {
            const operations: AnyBulkWriteOperation<SimulatedDeviceRecord>[] = [];
            for (const [mac, fields] of batch) {
                operations.push({ updateOne: { filter: { mac }, update: { $set: stripUndefined(fields) } } });
            }
            try {
                for (let index = 0; index < operations.length; index += BULK_CHUNK) {
                    await this.collection().bulkWrite(operations.slice(index, index + BULK_CHUNK), { ordered: false });
                }
            } catch (error) {
                // Keep failed fields for the next flush unless newer ones arrived.
                for (const [mac, fields] of batch) {
                    if (!this.pending.has(mac)) this.pending.set(mac, fields);
                }
                this.ensureTimer();
                throw error;
            }
        });
        this.inFlight = run;
        return run;
    }

    async stop(): Promise<void> {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        await this.flush().catch(() => undefined);
        await this.inFlight.catch(() => undefined);
    }

    private ensureTimer(): void {
        if (this.timer) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.flush().catch(() => undefined);
        }, this.intervalMs);
        this.timer.unref();
    }

    private collection() {
        return this.registryDb().collection<SimulatedDeviceRecord>('simulated_devices');
    }
}

const stripUndefined = (fields: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
);

let writerInstance: RegistryWriter | null = null;
export const getRegistryWriter = (): RegistryWriter => {
    if (!writerInstance) writerInstance = new RegistryWriter();
    return writerInstance;
};
