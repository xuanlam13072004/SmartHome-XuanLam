import { setTimeout as sleep } from 'node:timers/promises';
import { env } from '../config/env';

/**
 * Token bucket: `capacity` requests may go at once, then one per
 * `60 000 / perMinute` ms. Matches the API Gateway's per-minute windows
 * closely enough that 429 retries stay rare.
 */
export class TokenBucket {
    private tokens: number;
    private updatedAt: number;
    private queue: Promise<void> = Promise.resolve();

    constructor(
        readonly perMinute: number,
        readonly capacity = perMinute,
        private readonly now: () => number = Date.now,
        private readonly wait: (ms: number, signal?: AbortSignal) => Promise<unknown> =
        (ms, signal) => sleep(ms, undefined, { signal }),
    ) {
        this.tokens = capacity;
        this.updatedAt = now();
    }

    /** Resolves when one request may be sent; callers are served in order. */
    take(signal?: AbortSignal): Promise<void> {
        const turn = this.queue.then(async () => {
            signal?.throwIfAborted();
            this.refill();
            if (this.tokens < 1) {
                const waitMs = Math.ceil((1 - this.tokens) * 60_000 / this.perMinute);
                await this.wait(waitMs, signal);
                this.refill();
            }
            this.tokens -= 1;
        });
        this.queue = turn.catch(() => undefined);
        return turn;
    }

    /** True when the bucket is full again (an idle per-account bucket can be dropped). */
    get idle(): boolean {
        this.refill();
        return this.tokens >= this.capacity;
    }

    private refill(): void {
        const now = this.now();
        this.tokens = Math.min(this.capacity, this.tokens + (now - this.updatedAt) * this.perMinute / 60_000);
        this.updatedAt = now;
    }
}

/**
 * Paces generation against the API Gateway's rate limits instead of sleeping
 * a fixed time per user and per device. Registration and login are limited
 * per client IP (the whole simulator), device claims per account, so many
 * accounts claim in parallel.
 */
export class GatewayPacer {
    readonly register: TokenBucket;
    readonly login: TokenBucket;
    private readonly claims = new Map<string, TokenBucket>();

    constructor(private readonly limits = {
        registerPerMinute: env.GATEWAY_REGISTER_PER_MINUTE,
        loginPerMinute: env.GATEWAY_LOGIN_PER_MINUTE,
        claimPerAccountPerMinute: env.GATEWAY_CLAIM_PER_ACCOUNT_PER_MINUTE,
    }) {
        this.register = new TokenBucket(limits.registerPerMinute);
        this.login = new TokenBucket(limits.loginPerMinute);
    }

    claim(accountId: string, signal?: AbortSignal): Promise<void> {
        let bucket = this.claims.get(accountId);
        if (!bucket) {
            if (this.claims.size > 10_000) {
                for (const [key, value] of this.claims) if (value.idle) this.claims.delete(key);
            }
            bucket = new TokenBucket(this.limits.claimPerAccountPerMinute);
            this.claims.set(accountId, bucket);
        }
        return bucket.take(signal);
    }
}

let pacerInstance: GatewayPacer | null = null;
export const getGatewayPacer = (): GatewayPacer => {
    pacerInstance ||= new GatewayPacer();
    return pacerInstance;
};
