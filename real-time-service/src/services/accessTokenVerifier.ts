import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export interface VerifiedAccess {
    userId: string;
    /** Access-token expiry, epoch milliseconds. */
    expiresAtMs: number;
}

interface AccessClaims {
    userId?: string;
    purpose?: string;
    exp?: number;
}

export class AccessTokenRejectedError extends Error {}

/**
 * Verifies an access token for a realtime connection.
 *
 * The signature check runs locally so malformed or forged tokens are rejected
 * without a network hop. API Gateway remains the authority for account state:
 * `/auth/me` applies the same checks as every REST call (account active and
 * `token_version` unchanged), so a revoked or disabled account cannot open a
 * realtime channel with a still-unexpired token. Fails closed when the Gateway
 * cannot be reached.
 */
export async function verifyAccessToken(token: string): Promise<VerifiedAccess> {
    let claims: AccessClaims;
    try {
        claims = jwt.verify(token, env.JWT_SECRET) as AccessClaims;
    } catch {
        throw new AccessTokenRejectedError('Invalid authentication token');
    }
    if (!claims?.userId || claims.purpose || typeof claims.exp !== 'number') {
        throw new AccessTokenRejectedError('Invalid token payload');
    }

    let response: Response;
    try {
        response = await fetch(new URL('/auth/me', env.API_GATEWAY_URL), {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(env.AUTH_VERIFY_TIMEOUT_MS),
        });
    } catch (error) {
        throw new Error(`Account verification unavailable: ${String((error as Error)?.message || error)}`);
    }
    if (response.status === 401 || response.status === 403) {
        throw new AccessTokenRejectedError('Access token has been revoked');
    }
    if (!response.ok) {
        throw new Error(`Account verification failed with HTTP ${response.status}`);
    }
    const body = await response.json().catch(() => null) as { user?: { id?: string } } | null;
    if (body?.user?.id !== claims.userId) {
        throw new AccessTokenRejectedError('Token subject mismatch');
    }
    return { userId: claims.userId, expiresAtMs: claims.exp * 1000 };
}
