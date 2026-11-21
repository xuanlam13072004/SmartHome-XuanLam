import type { FastifyInstance } from 'fastify';
import { insertAccountNotification, publishAccountNotification } from '../notifications/accountNotifications';

/**
 * Temporary lock after repeated failed voice verifications: 5 failures, each
 * within 10 minutes of the previous one, lock voice verification (and changes
 * to the voice profile) for 15 minutes and notify the account. Unusable
 * recordings (too short, too noisy) are not failures. Counters live in Redis
 * so every Gateway instance shares them.
 */

export const VOICE_MAX_FAILURES = 5;
const FAILURE_WINDOW_SECONDS = 10 * 60;
export const VOICE_LOCK_SECONDS = 15 * 60;

const failKey = (accountId: string) => `voice:fail:${accountId}`;
const lockKey = (accountId: string) => `voice:lock:${accountId}`;

export interface VoiceLock {
    locked_until: string | null;
    failures_left: number;
}

export async function voiceLockState(app: FastifyInstance, accountId: string): Promise<VoiceLock> {
    const [ttl, failures] = await Promise.all([app.redis.pttl(lockKey(accountId)), app.redis.get(failKey(accountId))]);
    return {
        locked_until: ttl > 0 ? new Date(Date.now() + ttl).toISOString() : null,
        failures_left: ttl > 0 ? 0 : Math.max(0, VOICE_MAX_FAILURES - Number(failures ?? 0)),
    };
}

export async function assertVoiceUnlocked(app: FastifyInstance, accountId: string): Promise<void> {
    const state = await voiceLockState(app, accountId);
    if (!state.locked_until) return;
    const minutes = Math.max(1, Math.ceil((Date.parse(state.locked_until) - Date.now()) / 60_000));
    const error = new Error(
        `Xác minh giọng nói đang tạm khóa vì thử sai nhiều lần. Thử lại sau ${minutes} phút.`,
    ) as any;
    error.statusCode = 423;
    error.code = 'VOICE_LOCKED';
    error.details = { locked_until: state.locked_until };
    throw error;
}

export async function recordVoiceFailure(app: FastifyInstance, accountId: string): Promise<VoiceLock> {
    const results = await app.redis.multi()
        .incr(failKey(accountId))
        .expire(failKey(accountId), FAILURE_WINDOW_SECONDS)
        .exec();
    const failures = Number(results?.[0]?.[1] ?? 0);
    if (failures >= VOICE_MAX_FAILURES) {
        // NX: concurrent failures lock (and notify) only once.
        const locked = await app.redis.set(lockKey(accountId), '1', 'EX', VOICE_LOCK_SECONDS, 'NX');
        await app.redis.del(failKey(accountId));
        if (locked === 'OK') await notifyLocked(app, accountId);
    }
    return voiceLockState(app, accountId);
}

export async function clearVoiceFailures(app: FastifyInstance, accountId: string, includingLock = false) {
    await app.redis.del(...(includingLock ? [failKey(accountId), lockKey(accountId)] : [failKey(accountId)]));
}

async function notifyLocked(app: FastifyInstance, accountId: string) {
    try {
        const row = await insertAccountNotification(app.pg, {
            accountId,
            automationId: null,
            kind: 'security',
            title: 'Giọng nói tạm khóa',
            body: `Có ${VOICE_MAX_FAILURES} lần xác minh giọng nói không khớp liên tiếp. `
                + `Xác minh bằng giọng nói bị khóa ${VOICE_LOCK_SECONDS / 60} phút.`,
        });
        await publishAccountNotification(app, accountId, row);
    } catch (error) {
        app.log.warn({ error }, 'Failed to notify a voice lock');
    }
}
