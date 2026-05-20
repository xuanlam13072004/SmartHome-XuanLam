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

export async function registerUser(app: FastifyInstance, input: {
    username: string;
    email: string;
    password: string;
    full_name?: string;
}) {
    const email = normalizeEmail(input.email);

    const existing = await app.pg.query(
        'SELECT id FROM accounts WHERE email = $1 OR username = $2',
        [email, input.username]
    );

    if (existing.rows.length > 0) {
        const err = new Error('Email or username already exists') as any;
        err.statusCode = 409;
        err.code = 'ACCOUNT_EXISTS';
        throw err;
    }

    const passwordHash = await argon2.hash(input.password);

    const result = await app.pg.query(
        `
    INSERT INTO accounts (username, email, password_hash, full_name, created_at, updated_at)
    VALUES ($1, $2, $3, $4, NOW(), NOW())
    RETURNING id, username, email, full_name
    `,
        [input.username, email, passwordHash, input.full_name || null]
    );

    return result.rows[0];
}

export async function loginUser(app: FastifyInstance, input: {
    email: string;
    password: string;
}) {
    const email = normalizeEmail(input.email);

    const result = await app.pg.query(
        'SELECT id, username, email, password_hash, full_name FROM accounts WHERE email = $1',
        [email]
    );

    if (result.rows.length === 0) {
        const err = new Error('Invalid credentials') as any;
        err.statusCode = 401;
        err.code = 'INVALID_CREDENTIALS';
        throw err;
    }

    const user = result.rows[0];
    const valid = await argon2.verify(user.password_hash, input.password);

    if (!valid) {
        const err = new Error('Invalid credentials') as any;
        err.statusCode = 401;
        err.code = 'INVALID_CREDENTIALS';
        throw err;
    }

    const accessToken = app.jwt.sign(
        { userId: user.id, email: user.email },
        { expiresIn: env.JWT_EXPIRES_IN }
    );

    const refreshToken = generateRefreshToken();
    const refreshHash = await argon2.hash(refreshToken);
    const expiresAt = nowPlusSeconds(env.REFRESH_TOKEN_TTL_SECONDS);

    const session = await app.pg.query(
        `
    INSERT INTO user_sessions (owner_id, refresh_token_hash, is_active, expires_at, created_at)
    VALUES ($1, $2, true, $3, NOW())
    RETURNING id
    `,
        [user.id, refreshHash, expiresAt]
    );

    return {
        access_token: accessToken,
        refresh_token: refreshToken,
        session_id: session.rows[0].id,
        user: {
            id: user.id,
            username: user.username,
            email: user.email,
            full_name: user.full_name,
        },
    };
}

export async function refreshSession(app: FastifyInstance, input: {
    session_id: string;
    refresh_token: string;
}) {
    const result = await app.pg.query(
        `
    SELECT id, owner_id, refresh_token_hash, is_active, expires_at
    FROM user_sessions
    WHERE id = $1 AND is_active = true AND expires_at > NOW()
    `,
        [input.session_id]
    );

    if (result.rows.length === 0) {
        const err = new Error('Invalid session') as any;
        err.statusCode = 401;
        err.code = 'INVALID_SESSION';
        throw err;
    }

    const session = result.rows[0];
    const valid = await argon2.verify(session.refresh_token_hash, input.refresh_token);

    if (!valid) {
        const err = new Error('Invalid refresh token') as any;
        err.statusCode = 401;
        err.code = 'INVALID_REFRESH_TOKEN';
        throw err;
    }

    const accessToken = app.jwt.sign(
        { userId: session.owner_id },
        { expiresIn: env.JWT_EXPIRES_IN }
    );

    const newRefreshToken = generateRefreshToken();
    const newHash = await argon2.hash(newRefreshToken);
    const newExpiresAt = nowPlusSeconds(env.REFRESH_TOKEN_TTL_SECONDS);

    await app.pg.query(
        `
    UPDATE user_sessions
    SET refresh_token_hash = $1, expires_at = $2, is_active = true
    WHERE id = $3
    `,
        [newHash, newExpiresAt, session.id]
    );

    return {
        access_token: accessToken,
        refresh_token: newRefreshToken,
        session_id: session.id,
    };
}

export async function logoutSession(app: FastifyInstance, input: {
    session_id: string;
    refresh_token: string;
}) {
    const result = await app.pg.query(
        `
    SELECT id, refresh_token_hash
    FROM user_sessions
    WHERE id = $1 AND is_active = true
    `,
        [input.session_id]
    );

    if (result.rows.length === 0) {
        const err = new Error('Invalid session') as any;
        err.statusCode = 401;
        err.code = 'INVALID_SESSION';
        throw err;
    }

    const session = result.rows[0];
    const valid = await argon2.verify(session.refresh_token_hash, input.refresh_token);

    if (!valid) {
        const err = new Error('Invalid refresh token') as any;
        err.statusCode = 401;
        err.code = 'INVALID_REFRESH_TOKEN';
        throw err;
    }

    await app.pg.query(
        'UPDATE user_sessions SET is_active = false WHERE id = $1',
        [session.id]
    );

    return { success: true };
}
