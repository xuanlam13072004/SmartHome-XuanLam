import { MongoClient, Db } from 'mongodb';
import { env } from '../config/env.js';

let mongoClient: MongoClient | null = null;
let db: Db | null = null;

export async function connectMongo(): Promise<Db> {
    if (db) return db;

    try {
        mongoClient = new MongoClient(env.MONGO_URI);
        await mongoClient.connect();
        db = mongoClient.db(env.MONGO_DB_NAME);
        console.log('✅ Connected to MongoDB successfully.');
        return db;
    } catch (error) {
        console.error('❌ Failed to connect to MongoDB:', error);
        throw error;
    }
}

export function getDb(): Db {
    if (!db) {
        throw new Error('Database not initialized. Call connectMongo() first.');
    }
    return db;
}

export async function closeMongo(): Promise<void> {
    if (mongoClient) {
        await mongoClient.close();
        mongoClient = null;
        db = null;
        console.log('MongoClient connection closed.');
    }
}
