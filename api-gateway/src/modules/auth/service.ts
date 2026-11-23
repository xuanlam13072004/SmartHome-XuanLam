import argon2 from 'argon2';
import { FastifyInstance } from 'fastify';
import { env } from '../../config/env';
import { httpError } from '../../utils/httpError';
import {
    generateRefreshToken,
    hashRefreshToken,
    refreshTokenMatches,
    signAccessToken,
} from './tokens';
import { publishSessionsRevoked } from './sessionEvents';

export type ClientPlatform = 'web' | 'android' | 'ios' | 'windows' | 'macos' | 'linux' | 'unknown';

function nowPlusSeconds(seconds: number): Date {
    return new Date(Date.now() + seconds * 1000);
}

function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}

function authError(message: string, code: string) {
    const error = new Error(message) as any;
    error.statusCode = 401;
    error.code = code;
    return error;
}

export async function registerUser(app: FastifyInstance, input: {
    email: string;
    password: string;
    full_name: string;
}) {
    const email = normalizeEmail(input.email);
    const existing = await app.pg.query('SELECT id FROM accounts WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
        const error = new Error('An account with this email already exists.') as any;
        error.statusCode = 409;
        error.code = 'ACCOUNT_EXISTS';
        throw error;
    }

    const passwordHash = await argon2.hash(input.password);
    const result = await app.pg.query(
        `INSERT INTO accounts (email, password_hash, full_name)
         VALUES ($1, $2, $3)
         RETURNING id, email, full_name, status, created_at`,
        [email, passwordHash, input.full_name.trim()],
    );
    return result.rows[0];
}

export async function loginUser(app: FastifyInstance, input: {
    email: string;
    password: string;
    client?: { platform?: ClientPlatform; name?: string };
}) {
    const email = normalizeEmail(input.email);
    const result = await app.pg.query(
        `SELECT id, email, password_hash, full_name, status, token_version
         FROM accounts
         WHERE email = $1`,
        [email],
    );
    const user = result.rows[0];
    const usable = user && (user.status === 'active' || user.status === 'disabled');
    if (!usable || !(await argon2.verify(user.password_hash, input.password))) {
        throw authError('Invalid credentials', 'INVALID_CREDENTIALS');
    }
    // Locked by the administrator (docs/architecture/admin.md). Said only to
    // someone who knows the password, so it reveals nothing to a guesser.
    if (user.status === 'disabled') throw httpError(403, 'ACCOUNT_LOCKED', 'Tài khoản đã bị khóa.');

    const refreshToken = generateRefreshToken();
    const session = await app.pg.query(
        `INSERT INTO user_sessions
            (account_id, refresh_token_hash, status, client_platform, client_name, expires_at)
         VALUES ($1, $2, 'active', $3, $4, $5)
         RETURNING id`,
        [
            user.id,
            hashRefreshToken(refreshToken),
            input.client?.platform ?? 'unknown',
            input.client?.name ?? null,
            nowPlusSeconds(env.REFRESH_TOKEN_TTL_SECONDS),
        ],
    );
    const sessionId: string = session.rows[0].id;

    // Keep at most MAX_SESSIONS_PER_ACCOUNT: sign out the least recently used.
    const evicted = await app.pg.query(
        `UPDATE user_sessions SET status = 'revoked'
         WHERE id IN (
             SELECT id FROM user_sessions
             WHERE account_id = $1 AND status = 'active'
             ORDER BY COALESCE(last_used_at, created_at) DESC, created_at DESC
             OFFSET $2
         )
         RETURNING id`,
        [user.id, env.MAX_SESSIONS_PER_ACCOUNT],
    );
    await publishSessionsRevoked(app, user.id, evicted.rows.map(row => row.id));

    return {
        access_token: signAccessToken(app, {
            userId: user.id,
            email: user.email,
            tokenVersion: user.token_version,
            sid: sessionId,
        }),
        refresh_token: refreshToken,
        session_id: sessionId,
        user: {
            id: user.id,
            email: user.email,
            full_name: user.full_name,
        },
    };
}

export async function refreshSession(app: FastifyInstance, input: {
    session_id: string;
    refresh_token: string;
}) {
    const client = await app.pg.connect();
    try {
        await client.query('BEGIN');
        const result = await client.query(
            `SELECT session.id, session.account_id, session.refresh_token_hash,
                    account.email, account.status AS account_status, account.token_version
             FROM user_sessions AS session
             JOIN accounts AS account ON account.id = session.account_id
             WHERE session.id = $1
               AND session.status = 'active'
               AND session.expires_at > NOW()
             FOR UPDATE OF session`,
            [input.session_id],
        );
        const session = result.rows[0];
        if (!session || session.account_status !== 'active') {
            throw authError('Invalid session', 'INVALID_SESSION');
        }
        if (!refreshTokenMatches(session.refresh_token_hash, input.refresh_token)) {
            throw authError('Invalid refresh token', 'INVALID_REFRESH_TOKEN');
        }

        const refreshToken = generateRefreshToken();
        const expiresAt = nowPlusSeconds(env.REFRESH_TOKEN_TTL_SECONDS);
        await client.query(
            `UPDATE user_sessions
             SET refresh_token_hash = $1, expires_at = $2, last_used_at = NOW()
             WHERE id = $3`,
            [hashRefreshToken(refreshToken), expiresAt, session.id],
        );
        await client.query('COMMIT');

        return {
            access_token: signAccessToken(app, {
                userId: session.account_id,
                email: session.email,
                tokenVersion: session.token_version,
                sid: session.id,
            }),
            refresh_token: refreshToken,
            session_id: session.id,
        };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

export async function logoutSession(app: FastifyInstance, input: {
    session_id: string;
    refresh_token: string;
}) {
    const client = await app.pg.connect();
    try {
        await client.query('BEGIN');
        const result = await client.query(
            `SELECT id, refresh_token_hash
             FROM user_sessions
             WHERE id = $1 AND status = 'active'
             FOR UPDATE`,
            [input.session_id],
        );
        const session = result.rows[0];
        if (!session) throw authError('Invalid session', 'INVALID_SESSION');
        if (!refreshTokenMatches(session.refresh_token_hash, input.refresh_token)) {
            throw authError('Invalid refresh token', 'INVALID_REFRESH_TOKEN');
        }
        await client.query(
            `UPDATE user_sessions SET status = 'revoked', last_used_at = NOW() WHERE id = $1`,
            [session.id],
        );
        await client.query('COMMIT');
        return { success: true };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

export async function reauthenticateUser(
    app: FastifyInstance,
    accountId: string,
    password: string,
) {
    const result = await app.pg.query(
        `SELECT id, password_hash, status, token_version
         FROM accounts WHERE id = $1`,
        [accountId],
    );
    const account = result.rows[0];
    if (!account || account.status !== 'active'
        || !(await argon2.verify(account.password_hash, password))) {
        throw authError('Invalid credentials', 'INVALID_CREDENTIALS');
    }
    return {
        reauth_token: app.jwt.sign(
            { userId: account.id, purpose: 'reauth', tokenVersion: account.token_version },
            { expiresIn: 300 },
        ),
        expires_in: 300,
    };
}
