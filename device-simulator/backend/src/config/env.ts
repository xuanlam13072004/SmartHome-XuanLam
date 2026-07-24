import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
    PORT: z.string().transform(Number).default('4001'),
    HOST: z.string().default('0.0.0.0'),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    
    SIMULATOR_ENABLED: z.string().transform((val) => val === 'true'),
    ADMIN_TOKEN: z.string().min(8),
    CREDENTIAL_ENCRYPTION_KEY: z.string().length(64), // 32 bytes hex string
    
    API_GATEWAY_URL: z.string().url(),
    
    POSTGRES_USER: z.string(),
    POSTGRES_PASSWORD: z.string(),
    POSTGRES_DB: z.string(),
    POSTGRES_HOST: z.string(),
    POSTGRES_PORT: z.string().transform(Number).default('5432'),
    
    MONGODB_URI: z.string().url(),
    
    MQTT_HOST: z.string(),
    MQTT_PORT: z.string().transform(Number).default('1883'),
    MQTT_USERNAME: z.string().optional(),
    MQTT_PASSWORD: z.string().optional(),
});

const _env = envSchema.safeParse(process.env);

if (!_env.success) {
    console.error('❌ Invalid environment variables:', _env.error.format());
    process.exit(1);
}

export const env = _env.data;
