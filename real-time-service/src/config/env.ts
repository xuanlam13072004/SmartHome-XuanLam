import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';

// Load .env file
dotenv.config();

const envSchema = z.object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().positive().default(3001),

    JWT_SECRET: z.string().min(8),

    MONGO_URI: z.string().url(),
    MONGO_DB_NAME: z.string().default('SmartHomeDB'),
    MONGO_DEVICES_COLLECTION: z.string().default('devices'),

    REDIS_URL: z.string().url(),
});

const parseResult = envSchema.safeParse(process.env);

if (!parseResult.success) {
    console.error('❌ Environment validation failed in real-time-service:');
    parseResult.error.errors.forEach(err => {
        console.error(`  ${err.path.join('.')}: ${err.message}`);
    });
    process.exit(1);
}

export const env = parseResult.data;
