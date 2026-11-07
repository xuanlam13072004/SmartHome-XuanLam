import Redis from 'ioredis';
import { SessionAuthorizer, type MediaSessionProjection } from './auth';
import { MediaRelay } from './relay';

const PORT = Number(process.env.PORT || 8090);
const HOST = process.env.HOST || '0.0.0.0';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
// Must match shared/constants.js (CACHE_PREFIXES.MEDIA_SESSION, REDIS_CHANNELS.MEDIA_SESSION_REVOKED).
const SESSION_PREFIX = process.env.MEDIA_SESSION_PREFIX || 'media:session:';
const REVOKED_CHANNEL = process.env.MEDIA_SESSION_REVOKED_CHANNEL || 'media.session.revoked';

const log = (level: 'info' | 'warn', message: string, data: Record<string, unknown> = {}) => {
    const line = JSON.stringify({ level, time: new Date().toISOString(), service: 'media-relay-service', message, ...data });
    if (level === 'warn') console.warn(line);
    else console.log(line);
};

const start = async () => {
    const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 });
    const subscriber = new Redis(REDIS_URL);
    const authorizer = new SessionAuthorizer({
        async get(sessionId) {
            const raw = await redis.get(`${SESSION_PREFIX}${sessionId}`);
            return raw ? JSON.parse(raw) as MediaSessionProjection : null;
        },
    });
    const relay = new MediaRelay({ authorizer, log });
    await subscriber.subscribe(REVOKED_CHANNEL);
    subscriber.on('message', (_channel, message) => {
        try {
            const parsed = JSON.parse(message) as { session_ids?: unknown };
            if (Array.isArray(parsed.session_ids)) relay.revoke(parsed.session_ids.map(String));
        } catch {
            log('warn', 'Ignored a malformed revocation message');
        }
    });
    relay.server.listen(PORT, HOST, () => log('info', 'Media relay listening', { host: HOST, port: PORT }));
    const shutdown = () => {
        void relay.close().finally(() => {
            redis.disconnect();
            subscriber.disconnect();
            process.exit(0);
        });
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
};

start().catch((error) => {
    log('warn', 'Media relay failed to start', { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
});
