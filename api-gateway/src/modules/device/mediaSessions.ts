import crypto from 'crypto';
import type Redis from 'ioredis';
// @ts-ignore - shared CommonJS module
import { CACHE_PREFIXES, REDIS_CHANNELS } from '../../../../shared/constants';

/**
 * Media session helpers (docs/architecture/camera-contract.md, sections 6-7).
 *
 * PostgreSQL `device_resource_sessions` stays the source of truth. Redis holds
 * a projection the media relay reads to authorize HLS requests and device
 * ingest without a database connection; it expires with the session.
 */

export const MAX_OPERATION_RESULT_BYTES = 16 * 1024;

export interface MediaSessionProjection {
    session_id: string;
    device_id: string;
    device_mac: string;
    instance_id: string;
    resource_id: string;
    resource_kind: string;
    status: 'requested' | 'ready';
    access_token_hash: string;
    ingest_token_hash: string | null;
    expires_at: string;
}

export function hashToken(rawToken: string): string {
    return crypto.createHash('sha256').update(rawToken).digest('hex');
}

export function createToken(): { raw: string; hash: string } {
    const raw = crypto.randomBytes(32).toString('base64url');
    return { raw, hash: hashToken(raw) };
}

/**
 * Base URL of a session on the media relay. The app appends its own access
 * token and the playlist name: `<locator><access_token>/index.m3u8`. The token
 * is never stored, so the Gateway cannot (and must not) embed it.
 */
export function buildMediaLocator(publicUrl: string, sessionId: string): string {
    return `${publicUrl.replace(/\/+$/, '')}/v1/sessions/${sessionId}/`;
}

/** Device ACK details are kept only when they are a bounded JSON object. */
export function boundOperationResult(details: unknown): Record<string, unknown> | null {
    if (details === null || typeof details !== 'object' || Array.isArray(details)) return null;
    const keys = Object.keys(details as Record<string, unknown>);
    if (keys.length === 0) return null;
    const serialized = JSON.stringify(details);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_OPERATION_RESULT_BYTES) {
        return { truncated: true, size_bytes: Buffer.byteLength(serialized, 'utf8') };
    }
    return JSON.parse(serialized);
}

export function mediaSessionKey(sessionId: string): string {
    return `${CACHE_PREFIXES.MEDIA_SESSION}${sessionId}`;
}

export async function writeMediaSessionProjection(redis: Redis, projection: MediaSessionProjection) {
    const ttlMs = new Date(projection.expires_at).getTime() - Date.now();
    if (ttlMs <= 0) {
        await redis.del(mediaSessionKey(projection.session_id));
        return;
    }
    await redis.set(mediaSessionKey(projection.session_id), JSON.stringify(projection), 'PX', ttlMs);
}

export async function updateMediaSessionProjection(
    redis: Redis,
    sessionId: string,
    patch: Partial<Pick<MediaSessionProjection, 'status' | 'expires_at'>>,
) {
    const raw = await redis.get(mediaSessionKey(sessionId));
    if (!raw) return;
    await writeMediaSessionProjection(redis, { ...JSON.parse(raw), ...patch });
}

/** Removes the projections and tells the relay to drop open connections now. */
export async function revokeMediaSessions(redis: Redis, deviceMac: string, sessionIds: string[]) {
    if (sessionIds.length === 0) return;
    await redis.del(...sessionIds.map(mediaSessionKey));
    await redis.publish(REDIS_CHANNELS.MEDIA_SESSION_REVOKED, JSON.stringify({
        device_mac: deviceMac,
        session_ids: sessionIds,
        revoked_at: new Date().toISOString(),
    }));
}
