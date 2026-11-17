import crypto from 'crypto';
import type { FastifyInstance } from 'fastify';
import { env } from '../../config/env';

/**
 * Refresh tokens are 384 random bits, so a fast SHA-256 is enough to store
 * them (a slow password hash only matters for guessable secrets). This keeps a
 * refresh, which every client does every few minutes, cheap at 8k accounts.
 */
export function generateRefreshToken(): string {
    return crypto.randomBytes(48).toString('hex');
}

export function hashRefreshToken(token: string): string {
    return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

export function refreshTokenMatches(storedHash: string, token: string): boolean {
    const expected = Buffer.from(storedHash, 'hex');
    const actual = Buffer.from(hashRefreshToken(token), 'hex');
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export interface AccessClaims {
    userId: string;
    email: string;
    tokenVersion: number;
    /** Login session the token belongs to; revoking it invalidates the token at once. */
    sid: string;
}

export function signAccessToken(app: FastifyInstance, claims: AccessClaims): string {
    return app.jwt.sign({ ...claims }, { expiresIn: env.JWT_EXPIRES_IN });
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
