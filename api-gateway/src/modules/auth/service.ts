import argon2 from 'argon2';
import crypto from 'crypto';
import { FastifyInstance } from 'fastify';
import { env } from '../../config/env';

function nowPlusSeconds(seconds: number): Date {
    return new Date(Date.now() + seconds * 1000);
}

function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}

function generateRefreshToken(): string {
    return crypto.randomBytes(48).toString('hex');
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
}) {
    const email = normalizeEmail(input.email);
    const result = await app.pg.query(
        `SELECT id, email, password_hash, full_name, status, token_version
         FROM accounts
         WHERE email = $1`,
        [email],
    );
    const user = result.rows[0];
    if (!user || user.status !== 'active' || !(await argon2.verify(user.password_hash, input.password))) {
        throw authError('Invalid credentials', 'INVALID_CREDENTIALS');
    }

    const accessToken = app.jwt.sign(
        { userId: user.id, email: user.email, tokenVersion: user.token_version },
        { expiresIn: env.JWT_EXPIRES_IN },
    );
    const refreshToken = generateRefreshToken();
    const session = await app.pg.query(
        `INSERT INTO user_sessions (account_id, refresh_token_hash, status, expires_at)
         VALUES ($1, $2, 'active', $3)
         RETURNING id`,
        [
            user.id,
            await argon2.hash(refreshToken),
            nowPlusSeconds(env.REFRESH_TOKEN_TTL_SECONDS),
        ],
    );

    return {
        access_token: accessToken,
        refresh_token: refreshToken,
        session_id: session.rows[0].id,
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
        if (!(await argon2.verify(session.refresh_token_hash, input.refresh_token))) {
            throw authError('Invalid refresh token', 'INVALID_REFRESH_TOKEN');
        }

        const refreshToken = generateRefreshToken();
        const expiresAt = nowPlusSeconds(env.REFRESH_TOKEN_TTL_SECONDS);
        await client.query(
            `UPDATE user_sessions
             SET refresh_token_hash = $1, expires_at = $2, last_used_at = NOW()
             WHERE id = $3`,
            [await argon2.hash(refreshToken), expiresAt, session.id],
        );
        await client.query('COMMIT');

        return {
            access_token: app.jwt.sign(
                {
                    userId: session.account_id,
                    email: session.email,
                    tokenVersion: session.token_version,
                },
                { expiresIn: env.JWT_EXPIRES_IN },
            ),
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
        if (!(await argon2.verify(session.refresh_token_hash, input.refresh_token))) {
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
