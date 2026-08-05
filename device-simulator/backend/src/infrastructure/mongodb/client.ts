import { MongoClient, Db } from 'mongodb';
import { env } from '../../config/env';
import type { FastifyBaseLogger } from 'fastify';

let registryClient: MongoClient | null = null;
let mainClient: MongoClient | null = null;
let registryDb: Db | null = null;
let mainDb: Db | null = null;

export const initMongo = async (logger: FastifyBaseLogger): Promise<void> => {
    registryClient = new MongoClient(env.MONGODB_URI);
    mainClient = new MongoClient(env.MAIN_MONGODB_URI || env.MONGODB_URI);

    try {
        await Promise.all([registryClient.connect(), mainClient.connect()]);
        registryDb = registryClient.db(env.SIMULATOR_MONGO_DB_NAME);
        mainDb = mainClient.db(env.MAIN_MONGO_DB_NAME);
        logger.info({
            registryDatabase: env.SIMULATOR_MONGO_DB_NAME,
            mainDatabase: env.MAIN_MONGO_DB_NAME,
        }, 'Connected to MongoDB databases');

        await setupCollections(logger);
    } catch (err) {
        logger.error({ err }, 'Failed to connect to MongoDB');
        throw err;
    }
};

const setupCollections = async (logger: FastifyBaseLogger): Promise<void> => {
    if (!registryDb) {
        throw new Error('Simulator registry database is unavailable');
    }

    try {
        const collectionNames = new Set(
            (await registryDb.listCollections({}, { nameOnly: true }).toArray())
                .map((collection) => collection.name),
        );

        for (const collectionName of [
            'simulation_runs',
            'simulated_users',
            'simulated_devices',
            'simulator_events',
        ]) {
            if (!collectionNames.has(collectionName)) {
                await registryDb.createCollection(collectionName);
            }
        }

        const simulatedUsers = registryDb.collection('simulated_users');
        const accountIdIndexName = 'account_id_string_unique_v2';
        await Promise.all([
            registryDb.collection('simulation_runs').createIndex({ id: 1 }, { unique: true }),
            registryDb.collection('simulation_runs').createIndex({ status: 1, created_at: -1 }),
            registryDb.collection('simulation_runs').createIndex({ cleanup_after: 1, status: 1 }),
            registryDb.collection('simulated_users').createIndex(
                { run_id: 1, generation_index: 1 },
                { unique: true },
            ),
            simulatedUsers.createIndex(
                { account_id: 1 },
                {
                    name: accountIdIndexName,
                    unique: true,
                    partialFilterExpression: { account_id: { $type: 'string' } },
                },
            ),
            registryDb.collection('simulated_users').createIndex({ run_id: 1, created_at: -1 }),
            registryDb.collection('simulated_users').createIndex({ retention_policy: 1, expires_at: 1 }),
            registryDb.collection('simulated_devices').createIndex({ mac: 1 }, { unique: true }),
            registryDb.collection('simulated_devices').createIndex(
                { run_id: 1, simulator_user_id: 1, generation_index: 1 },
                { unique: true },
            ),
            registryDb.collection('simulated_devices').createIndex({ desired_state: 1, provisioning_state: 1 }),
            registryDb.collection('simulated_devices').createIndex({
                run_id: 1,
                network_id: 1,
                topology_role: 1,
            }),
            registryDb.collection('simulator_events').createIndex({ run_id: 1, created_at: -1 }),
            registryDb.collection('simulator_events').createIndex({ mac: 1, created_at: -1 }),
            registryDb.collection('simulator_events').createIndex(
                { expires_at: 1 },
                { expireAfterSeconds: 0 },
            ),
        ]);

        logger.info('MongoDB simulator collections and indexes verified');
    } catch (err) {
        logger.error({ err }, 'Failed to setup MongoDB simulator collections and indexes');
        throw err;
    }
};

export const getMongoDb = (): Db => {
    if (!registryDb) {
        throw new Error('MongoDB has not been initialized');
    }
    return registryDb;
};

export const getMainMongoDb = (): Db => {
    if (!mainDb) {
        throw new Error('Main MongoDB has not been initialized');
    }
    return mainDb;
};

export const pingMongo = async (): Promise<void> => {
    await Promise.all([
        getMongoDb().command({ ping: 1 }),
        getMainMongoDb().command({ ping: 1 }),
    ]);
};

export const closeMongo = async (): Promise<void> => {
    const clients = new Set([registryClient, mainClient].filter(Boolean) as MongoClient[]);
    await Promise.all([...clients].map((mongoClient) => mongoClient.close()));
    registryClient = null;
    mainClient = null;
    registryDb = null;
    mainDb = null;
};
