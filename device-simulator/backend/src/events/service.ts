import { EventEmitter } from 'node:events';
import { env } from '../config/env';
import type { SimulatorEventRecord } from '../domain/registry';
import { getMongoDb } from '../infrastructure/mongodb/client';

export const simulatorEvents = new EventEmitter();
simulatorEvents.setMaxListeners(0);

type EventInput = Omit<SimulatorEventRecord, 'created_at' | 'expires_at'>;

export const recordSimulatorEvent = async (input: EventInput): Promise<void> => {
    const createdAt = new Date();
    const event: SimulatorEventRecord = {
        ...input,
        created_at: createdAt,
        expires_at: new Date(createdAt.getTime() + env.EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000),
    };

    await getMongoDb().collection<SimulatorEventRecord>('simulator_events').insertOne(event);
    simulatorEvents.emit('event', event);
};
