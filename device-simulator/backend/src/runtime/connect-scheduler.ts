import type { FastifyBaseLogger } from 'fastify';
import { env } from '../config/env';

/**
 * One door for opening MQTT connections in bulk (docs/architecture/
 * load-testing.md): generation, "Bật lại thiết bị" and a restart all queue
 * their devices here instead of connecting at once. At most
 * MQTT_CONNECTS_PER_SECOND connections start per second and at most
 * MQTT_CONNECT_CONCURRENCY wait for their CONNACK together, so the broker sees
 * a steady flow, never a burst of thousands.
 *
 * A device that cannot connect (timeout, broker busy or restarting) is tried
 * again later with a growing, jittered delay; it does not fail its user or
 * its run. A login the broker refuses is not retried: the account is gone
 * (retired) or the password is wrong, and retrying would only add load.
 */

export interface ConnectTarget {
    readonly mac: string;
    /** Opens the connection; rejects when it could not (CONNACK timeout, refused…). */
    connect(): Promise<void>;
    /** False once the device was stopped, removed or disposed: its queued work is dropped. */
    wantsConnection(): boolean;
}

export interface ConnectSchedulerStats {
    queued: number;
    connecting: number;
    retrying: number;
    connected_total: number;
    failed_attempts_total: number;
    refused_total: number;
}

const BASE_RETRY_MS = 5_000;
const MAX_RETRY_MS = 5 * 60_000;

/** CONNACK "bad user name or password" / "not authorized" (MQTT 3.1.1 and 5). */
export const isLoginRefused = (error: unknown): boolean => {
    const code = (error as { code?: number } | null)?.code;
    const message = error instanceof Error ? error.message : String(error);
    return code === 4 || code === 5 || code === 134 || code === 135
        || /bad user ?name or password|not authori[sz]ed/i.test(message);
};

/** 5 s, 10 s, 20 s… up to 5 minutes, each ±30 % so retries never line up. */
export const retryDelayMs = (attempt: number, random: () => number = Math.random): number => {
    const base = Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** Math.max(0, attempt - 1));
    return Math.round(base * (0.7 + random() * 0.6));
};

interface Entry {
    target: ConnectTarget;
    attempt: number;
}

export class ConnectScheduler {
    private readonly queue: Entry[] = [];
    private readonly pending = new Set<string>();
    private readonly retryTimers = new Map<string, NodeJS.Timeout>();
    private connecting = 0;
    private tokens: number;
    private lastRefill = Date.now();
    private pump: NodeJS.Timeout | null = null;
    private stopped = false;
    private connectedTotal = 0;
    private failedAttempts = 0;
    private refused = 0;
    private refusedListener: ((mac: string, error: unknown) => void) | null = null;

    constructor(
        private readonly logger: FastifyBaseLogger,
        private readonly perSecond = env.MQTT_CONNECTS_PER_SECOND,
        private readonly concurrency = env.MQTT_CONNECT_CONCURRENCY,
    ) {
        this.tokens = perSecond;
    }

    /** Told about a device whose login the broker refused (the runtime manager marks it). */
    setRefusedListener(listener: ((mac: string, error: unknown) => void) | null): void {
        this.refusedListener = listener;
    }

    /** Queues a device; a device already queued, connecting or waiting to retry is not added twice. */
    submit(target: ConnectTarget): void {
        if (this.stopped || this.pending.has(target.mac)) return;
        this.pending.add(target.mac);
        this.queue.push({ target, attempt: 1 });
        this.schedulePump(0);
    }

    /** Forgets a device (stopped, unpaired, cleaned): queued work and retries are dropped. */
    forget(mac: string): void {
        const timer = this.retryTimers.get(mac);
        if (timer) clearTimeout(timer);
        this.retryTimers.delete(mac);
        this.pending.delete(mac);
        const index = this.queue.findIndex(entry => entry.target.mac === mac);
        if (index >= 0) this.queue.splice(index, 1);
    }

    stats(): ConnectSchedulerStats {
        return {
            queued: this.queue.length,
            connecting: this.connecting,
            retrying: this.retryTimers.size,
            connected_total: this.connectedTotal,
            failed_attempts_total: this.failedAttempts,
            refused_total: this.refused,
        };
    }

    stop(): void {
        this.stopped = true;
        if (this.pump) clearTimeout(this.pump);
        this.pump = null;
        for (const timer of this.retryTimers.values()) clearTimeout(timer);
        this.retryTimers.clear();
        this.queue.length = 0;
        this.pending.clear();
    }

    private schedulePump(delayMs: number): void {
        if (this.pump || this.stopped) return;
        this.pump = setTimeout(() => {
            this.pump = null;
            this.drain();
        }, delayMs);
        this.pump.unref?.();
    }

    private refill(): void {
        const now = Date.now();
        this.tokens = Math.min(this.perSecond, this.tokens + ((now - this.lastRefill) / 1000) * this.perSecond);
        this.lastRefill = now;
    }

    private drain(): void {
        this.refill();
        while (this.queue.length > 0 && this.connecting < this.concurrency && this.tokens >= 1) {
            const entry = this.queue.shift()!;
            if (!entry.target.wantsConnection()) {
                this.pending.delete(entry.target.mac);
                continue;
            }
            this.tokens -= 1;
            this.connecting += 1;
            void this.attempt(entry);
        }
        if (this.queue.length > 0) {
            // The next token, or a free slot when the concurrency cap was the limit.
            const waitMs = this.tokens >= 1 ? 50 : Math.ceil(((1 - this.tokens) / this.perSecond) * 1000);
            this.schedulePump(waitMs);
        }
    }

    private async attempt(entry: Entry): Promise<void> {
        const { target } = entry;
        try {
            await target.connect();
            this.connectedTotal += 1;
            this.pending.delete(target.mac);
        } catch (error) {
            if (isLoginRefused(error)) {
                this.refused += 1;
                this.pending.delete(target.mac);
                this.logger.warn({ mac: target.mac, err: error }, 'Broker refused the virtual device login; not retrying');
                this.refusedListener?.(target.mac, error);
            } else if (!target.wantsConnection() || this.stopped) {
                this.pending.delete(target.mac);
            } else {
                this.failedAttempts += 1;
                const delay = retryDelayMs(entry.attempt);
                if (entry.attempt === 1 || entry.attempt % 5 === 0) {
                    this.logger.warn({ mac: target.mac, attempt: entry.attempt, retryInMs: delay, err: error },
                        'Virtual device could not connect; retrying later');
                }
                const timer = setTimeout(() => {
                    this.retryTimers.delete(target.mac);
                    if (this.stopped || !this.pending.has(target.mac)) return;
                    this.queue.push({ target, attempt: entry.attempt + 1 });
                    this.schedulePump(0);
                }, delay);
                timer.unref?.();
                this.retryTimers.set(target.mac, timer);
            }
        } finally {
            this.connecting -= 1;
            if (this.queue.length > 0) this.schedulePump(0);
        }
    }
}

let scheduler: ConnectScheduler | null = null;

export const getConnectScheduler = (logger: FastifyBaseLogger): ConnectScheduler => {
    if (!scheduler) scheduler = new ConnectScheduler(logger);
    return scheduler;
};

export const stopConnectScheduler = (): void => {
    scheduler?.stop();
    scheduler = null;
};
