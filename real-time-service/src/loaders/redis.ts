import Redis from 'ioredis';
import { env } from '../config/env.js';

let redisStd: Redis | null = null;
let redisSub: Redis | null = null;

export function initRedis(): { std: Redis; sub: Redis } {
    if (redisStd && redisSub) {
        return { std: redisStd, sub: redisSub };
    }

    try {
        redisStd = new Redis(env.REDIS_URL, {
            maxRetriesPerRequest: null,
        });

        redisSub = new Redis(env.REDIS_URL, {
            maxRetriesPerRequest: null,
        });

        redisStd.on('connect', () => console.log('✅ Redis Standard Client connected.'));
        redisStd.on('error', (err) => console.error('❌ Redis Standard Client error:', err));

        redisSub.on('connect', () => console.log('✅ Redis Subscriber Client connected.'));
        redisSub.on('error', (err) => console.error('❌ Redis Subscriber Client error:', err));

        return { std: redisStd, sub: redisSub };
    } catch (error) {
        console.error('❌ Failed to initialize Redis clients:', error);
        throw error;
    }
}

export function getRedisStd(): Redis {
    if (!redisStd) {
        throw new Error('Redis Standard Client not initialized. Call initRedis() first.');
    }
    return redisStd;
}

export function getRedisSub(): Redis {
    if (!redisSub) {
        throw new Error('Redis Subscriber Client not initialized. Call initRedis() first.');
    }
    return redisSub;
}

export async function closeRedis(): Promise<void> {
    if (redisStd) {
        await redisStd.quit();
        redisStd = null;
    }
    if (redisSub) {
        await redisSub.quit();
        redisSub = null;
    }
    console.log('Redis connections closed.');
}
