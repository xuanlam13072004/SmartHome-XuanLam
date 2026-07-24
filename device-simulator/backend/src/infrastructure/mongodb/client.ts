import { MongoClient, Db } from 'mongodb';
import { env } from '../../config/env';
import pino from 'pino';

let client: MongoClient | null = null;
let db: Db | null = null;

export const initMongo = async (logger: pino.Logger) => {
    client = new MongoClient(env.MONGODB_URI);

    try {
        await client.connect();
        db = client.db();
        logger.info('✅ Connected to MongoDB (DeviceSimulatorDB)');

        await setupCollections(logger);
    } catch (err) {
        logger.error({ err }, '❌ Failed to connect to MongoDB');
        throw err;
    }
};

const setupCollections = async (logger: pino.Logger) => {
    if (!db) return;

    try {
        // Create collections if they don't exist
        const collections = await db.listCollections().toArray();
        const collectionNames = collections.map(c => c.name);

        if (!collectionNames.includes('simulation_runs')) {
            await db.createCollection('simulation_runs');
        }
        if (!collectionNames.includes('simulated_users')) {
            await db.createCollection('simulated_users');
        }
        if (!collectionNames.includes('simulated_devices')) {
            await db.createCollection('simulated_devices');
        }
        if (!collectionNames.includes('simulator_events')) {
            await db.createCollection('simulator_events');
        }

        // Setup Indexes
        await db.collection('simulation_runs').createIndex({ status: 1 });
        await db.collection('simulation_runs').createIndex({ cleanup_after: 1 });

        await db.collection('simulated_users').createIndex({ run_id: 1 });
        await db.collection('simulated_users').createIndex({ account_id: 1 }, { unique: true });
        await db.collection('simulated_users').createIndex({ retention_policy: 1, expires_at: 1 });

        await db.collection('simulated_devices').createIndex({ run_id: 1 });
        await db.collection('simulated_devices').createIndex({ mac: 1 }, { unique: true });
        await db.collection('simulated_devices').createIndex({ simulator_user_id: 1 });

        // TTL index for events (7 days = 604800 seconds)
        await db.collection('simulator_events').createIndex(
            { created_at: 1 }, 
            { expireAfterSeconds: 604800 }
        );
        await db.collection('simulator_events').createIndex({ mac: 1, created_at: -1 });

        logger.info('✅ MongoDB collections and indexes verified');
    } catch (err) {
        logger.error({ err }, '❌ Failed to setup MongoDB collections and indexes');
        throw err;
    }
};

export const getMongoDb = (): Db => {
    if (!db) {
        throw new Error('MongoDB has not been initialized');
    }
    return db;
};
