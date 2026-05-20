import { z } from 'zod';

const envSchema = z.object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().positive().default(3000),

    JWT_SECRET: z.string().min(8),
    JWT_EXPIRES_IN: z.coerce.number().int().positive().default(900),
    REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(604800),

    PG_HOST: z.string(),
    PG_PORT: z.coerce.number().int().positive().default(5432),
    PG_DATABASE: z.string(),
    PG_USER: z.string(),
    PG_PASSWORD: z.string(),
    PG_SSL: z.enum(['true', 'false']).transform(v => v === 'true').default('false'),

    MONGO_URI: z.string().url(),
    MONGO_DB_NAME: z.string().default('SmartHomeDB'),

    REDIS_URL: z.string().url(),
});

const parseResult = envSchema.safeParse(process.env);

if (!parseResult.success) {
    console.error('❌ Environment validation failed:');
    parseResult.error.errors.forEach(err => {
        console.error(`  ${err.path.join('.')}: ${err.message}`);
    });
    process.exit(1);
}

export const env = parseResult.data;
