import { EventEmitter } from 'node:events';
import { env } from '../config/env';
import type { SimulatorEventRecord } from '../domain/registry';
import { getMongoDb } from '../infrastructure/mongodb/client';

export const simulatorEvents = new EventEmitter();
simulatorEvents.setMaxListeners(0);

type EventInput = Omit<SimulatorEventRecord, 'created_at' | 'expires_at'>;

const FLUSH_INTERVAL_MS = 500;
const MAX_BATCH = 1000;
/** Bounded: if MongoDB is down the oldest unsaved events are dropped first. */
const MAX_BUFFERED = 20_000;

let buffer: SimulatorEventRecord[] = [];
let timer: NodeJS.Timeout | null = null;
let flushing: Promise<void> = Promise.resolve();

/**
 * Records a simulator event. Events are announced immediately and written to
 * MongoDB in batches (`insertMany` every 500 ms): starting 30 000 devices
 * produces tens of thousands of events that would otherwise cost one insert
 * each.
 */
export const recordSimulatorEvent = async (input: EventInput): Promise<void> => {
    const createdAt = new Date();
    const event: SimulatorEventRecord = {
        ...input,
        created_at: createdAt,
        expires_at: new Date(createdAt.getTime() + env.EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000),
    };
    buffer.push(event);
    if (buffer.length > MAX_BUFFERED) buffer.splice(0, buffer.length - MAX_BUFFERED);
    if (buffer.length >= MAX_BATCH) void flushSimulatorEvents();
    else if (!timer) {
        timer = setTimeout(() => void flushSimulatorEvents(), FLUSH_INTERVAL_MS);
        timer.unref();
    }
    simulatorEvents.emit('event', event);
};

export const flushSimulatorEvents = (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (buffer.length === 0) return flushing;
    const batch = buffer;
    buffer = [];
    flushing = flushing.catch(() => undefined).then(async () => {
        try {
            for (let index = 0; index < batch.length; index += MAX_BATCH) {
                await getMongoDb().collection<SimulatorEventRecord>('simulator_events')
                    .insertMany(batch.slice(index, index + MAX_BATCH), { ordered: false });
            }
        } catch (error) {
            // A bulk error means part of the batch was written; retrying would duplicate it.
            if ((error as { name?: string })?.name === 'MongoBulkWriteError') return;
            // Unreachable database: keep them for the next flush (bounded by MAX_BUFFERED).
            buffer = [...batch, ...buffer].slice(-MAX_BUFFERED);
            if (!timer) {
                timer = setTimeout(() => void flushSimulatorEvents(), 5000);
                timer.unref();
            }
        }
    });
    return flushing;
};
