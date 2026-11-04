import { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import rateLimit from '@fastify/rate-limit';
import { env } from '../config/env';

/**
 * rateLimitPlugin
 * - Bộ đếm lưu trong Redis để mọi instance API Gateway dùng chung giới hạn.
 * - Chạy ở preHandler nên đã có request.body (đã validate) và request.user
 *   (sau app.authenticate). Nhờ vậy giới hạn được tính theo tài khoản, email
 *   hoặc phiên thay vì theo IP: nhiều người dùng chung một NAT không chặn nhau.
 * - global=false: chỉ route khai báo config.rateLimit mới bị giới hạn.
 */

type KeyFn = (request: FastifyRequest) => string;

function normalizeIdentity(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase();
    return normalized.length > 0 ? normalized : null;
}

/** Khóa mặc định: tài khoản đã xác thực, nếu chưa có thì IP. */
export function accountOrIpKey(request: FastifyRequest): string {
    const userId = (request.user as { userId?: string } | undefined)?.userId;
    return userId ? `account:${userId}` : `ip:${request.ip}`;
}

export function ipKey(request: FastifyRequest): string {
    return `ip:${request.ip}`;
}

/** Khóa theo một trường trong body (email, session_id); thiếu thì về IP. */
export function bodyFieldKey(field: string): KeyFn {
    return (request) => {
        const value = normalizeIdentity((request.body as Record<string, unknown> | undefined)?.[field]);
        return value ? `${field}:${value}` : ipKey(request);
    };
}

const rateLimitPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
    await app.register(rateLimit, {
        global: false,
        hook: 'preHandler',
        redis: app.redis,
        nameSpace: 'rate-limit:',
        keyGenerator: accountOrIpKey,
        addHeaders: {
            'x-ratelimit-limit': true,
            'x-ratelimit-remaining': true,
            'x-ratelimit-reset': true,
            'retry-after': true,
        },
    });

    /**
     * Giới hạn bổ sung chạy độc lập với config.rateLimit của route, ví dụ
     * đăng nhập vừa giới hạn theo email vừa có trần thô theo IP.
     */
    app.decorate('limitBy', (name: string, keyGenerator: KeyFn, max: number, timeWindowMs = 60_000) => {
        const limiter = app.createRateLimit({
            keyGenerator: (request: FastifyRequest) => `${name}:${keyGenerator(request)}`,
            max,
            timeWindow: timeWindowMs,
        });
        return async (request: FastifyRequest, reply: FastifyReply) => {
            const result = await limiter(request);
            if (result.isAllowed || !result.isExceeded) return;
            reply.header('retry-after', result.ttlInSeconds);
            const error = new Error(
                `Rate limit exceeded, retry in ${result.ttlInSeconds} seconds`,
            ) as Error & { statusCode: number; code: string };
            error.statusCode = 429;
            error.code = 'RATE_LIMITED';
            throw error;
        };
    });
};

declare module 'fastify' {
    interface FastifyInstance {
        limitBy: (
            name: string,
            keyGenerator: KeyFn,
            max: number,
            timeWindowMs?: number,
        ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    }
}

export const rateLimitLimits = {
    registerPerIp: () => env.RATE_LIMIT_REGISTER_PER_IP_PER_MINUTE,
    loginPerEmail: () => env.RATE_LIMIT_LOGIN_PER_EMAIL_PER_MINUTE,
    loginPerIp: () => env.RATE_LIMIT_LOGIN_PER_IP_PER_MINUTE,
    refreshPerSession: () => env.RATE_LIMIT_REFRESH_PER_SESSION_PER_MINUTE,
    claimPerAccount: () => env.RATE_LIMIT_CLAIM_PER_ACCOUNT_PER_MINUTE,
    operationsPerAccount: () => env.RATE_LIMIT_OPERATIONS_PER_ACCOUNT_PER_MINUTE,
};

export default fp(rateLimitPlugin, {
    name: 'rate-limit-plugin',
    dependencies: ['redis-plugin'],
});
