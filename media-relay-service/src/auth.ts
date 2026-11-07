import crypto from 'node:crypto';

/**
 * Session projection written by the API Gateway (`media:session:<id>`), see
 * api-gateway/src/modules/device/mediaSessions.ts. PostgreSQL stays the
 * source of truth; the relay only reads this short-lived copy.
 */
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

export interface SessionSource {
    get(sessionId: string): Promise<MediaSessionProjection | null>;
}

export const SESSION_ID = /^[0-9a-fA-F-]{36}$/;
export const TOKEN = /^[A-Za-z0-9_-]{20,128}$/;

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest();

const hashMatches = (raw: string, expectedHex: string | null | undefined): boolean => {
    if (!expectedHex || !/^[0-9a-f]{64}$/i.test(expectedHex)) return false;
    return crypto.timingSafeEqual(sha256(raw), Buffer.from(expectedHex, 'hex'));
};

export type AuthFailure = 'not_found' | 'expired' | 'forbidden' | 'not_ready' | 'wrong_kind';

export interface AuthResult {
    ok: boolean;
    projection?: MediaSessionProjection;
    reason?: AuthFailure;
}

/**
 * Checks tokens against the projection on every request (contract 6.3). A
 * tiny cache absorbs the burst of playlist/segment requests of one player;
 * revocations clear it immediately.
 */
export class SessionAuthorizer {
    private readonly cache = new Map<string, { at: number; value: MediaSessionProjection | null }>();
    private readonly revoked = new Map<string, number>();

    constructor(
        private readonly source: SessionSource,
        private readonly cacheMs = 1000,
        private readonly now: () => number = Date.now,
    ) {}

    /** Called for revocation messages from the Gateway. */
    revoke(sessionIds: string[]): void {
        const until = this.now() + 10 * 60 * 1000;
        for (const id of sessionIds) {
            this.cache.delete(id);
            this.revoked.set(id, until);
        }
    }

    isRevoked(sessionId: string): boolean {
        const until = this.revoked.get(sessionId);
        if (until === undefined) return false;
        if (until < this.now()) {
            this.revoked.delete(sessionId);
            return false;
        }
        return true;
    }

    async load(sessionId: string): Promise<MediaSessionProjection | null> {
        if (!SESSION_ID.test(sessionId) || this.isRevoked(sessionId)) return null;
        const cached = this.cache.get(sessionId);
        if (cached && this.now() - cached.at < this.cacheMs) return cached.value;
        const value = await this.source.get(sessionId);
        this.cache.set(sessionId, { at: this.now(), value });
        if (this.cache.size > 5000) {
            for (const key of [...this.cache.keys()].slice(0, 1000)) this.cache.delete(key);
        }
        return value;
    }

    /** Viewer access (HLS). The device must have acknowledged the session. */
    async authorizeViewer(sessionId: string, token: string): Promise<AuthResult> {
        if (!TOKEN.test(token)) return { ok: false, reason: 'forbidden' };
        const projection = await this.load(sessionId);
        const failure = this.check(projection);
        if (failure) return { ok: false, reason: failure };
        if (!hashMatches(token, projection!.access_token_hash)) return { ok: false, reason: 'forbidden' };
        if (projection!.status !== 'ready') return { ok: false, reason: 'not_ready', projection: projection! };
        return { ok: true, projection: projection! };
    }

    /** Device ingest. Allowed while the session waits for the device ACK and after. */
    async authorizeIngest(sessionId: string, token: string, mac: string): Promise<AuthResult> {
        if (!TOKEN.test(token)) return { ok: false, reason: 'forbidden' };
        const projection = await this.load(sessionId);
        const failure = this.check(projection);
        if (failure) return { ok: false, reason: failure };
        if (!hashMatches(token, projection!.ingest_token_hash)) return { ok: false, reason: 'forbidden' };
        if (projection!.device_mac.toUpperCase() !== mac.toUpperCase()) return { ok: false, reason: 'forbidden' };
        return { ok: true, projection: projection! };
    }

    private check(projection: MediaSessionProjection | null): AuthFailure | null {
        if (!projection) return 'not_found';
        if (projection.resource_kind !== 'video_stream') return 'wrong_kind';
        if (Date.parse(projection.expires_at) <= this.now()) return 'expired';
        return null;
    }
}
