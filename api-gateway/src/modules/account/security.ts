import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import { env } from '../../config/env';
import { httpError } from '../../utils/httpError';
import { recordAudit } from '../activity/audit';
import { publishSessionsRevoked } from '../auth/sessionEvents';
import { signAccessToken } from '../auth/tokens';
import { AccessChange, publishAccessChanges, queueAccessProjection } from '../sharing/access';

export interface SessionView {
    id: string;
    platform: string;
    name: string | null;
    created_at: string;
    last_active_at: string;
    current: boolean;
}

/**
 * Reads the account and checks a password without holding locks: argon2 takes
 * tens of milliseconds. Callers update with `password_hash = $old` so a
 * concurrent change is detected instead of silently overwritten.
 */
export async function verifyPassword(app: FastifyInstance, accountId: string, password: string) {
    const result = await app.pg.query(
        `SELECT email, password_hash, token_version
         FROM accounts WHERE id = $1 AND status = 'active'`,
        [accountId],
    );
    const account = result.rows[0];
    if (!account) throw httpError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
    // 403, not 401: a wrong password must not look like an expired access token.
    if (!(await argon2.verify(account.password_hash, password))) {
        throw httpError(403, 'INVALID_PASSWORD', 'Password is incorrect');
    }
    return account as { email: string; password_hash: string; token_version: number };
}

/**
 * Sets a new password, invalidates every access token of the account and
 * signs out all other sessions. The caller's session stays signed in with
 * the fresh access token returned here.
 */
export async function changePassword(
    app: FastifyInstance,
    accountId: string,
    sessionId: string,
    input: { current_password: string; new_password: string },
) {
    if (input.current_password === input.new_password) {
        throw httpError(400, 'PASSWORD_UNCHANGED', 'The new password must differ from the current one');
    }
    const account = await verifyPassword(app, accountId, input.current_password);
    const newHash = await argon2.hash(input.new_password);

    const client = await app.pg.connect();
    let revokedIds: string[] = [];
    let tokenVersion = 0;
    try {
        await client.query('BEGIN');
        const updated = await client.query(
            `UPDATE accounts
             SET password_hash = $3, token_version = token_version + 1
             WHERE id = $1 AND password_hash = $2 AND status = 'active'
             RETURNING token_version`,
            [accountId, account.password_hash, newHash],
        );
        if (!updated.rows[0]) {
            throw httpError(409, 'PASSWORD_CHANGED_CONCURRENTLY', 'The password was changed meanwhile');
        }
        tokenVersion = Number(updated.rows[0].token_version);
        const revoked = await client.query(
            `UPDATE user_sessions SET status = 'revoked'
             WHERE account_id = $1 AND status = 'active' AND id <> $2
             RETURNING id`,
            [accountId, sessionId],
        );
        revokedIds = revoked.rows.map(row => row.id);
        await recordAudit(client, {
            actorAccountId: accountId,
            action: 'account.password_changed',
            metadata: { signed_out_sessions: revokedIds.length },
        });
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }

    await publishSessionsRevoked(app, accountId, revokedIds);
    return {
        access_token: signAccessToken(app, {
            userId: accountId,
            email: account.email,
            tokenVersion,
            sid: sessionId,
        }),
        signed_out_sessions: revokedIds.length,
    };
}

/** Active sessions, most recently used first (bounded by MAX_SESSIONS_PER_ACCOUNT). */
export async function listSessions(
    app: FastifyInstance,
    accountId: string,
    currentSessionId: string,
): Promise<SessionView[]> {
    const result = await app.pg.query(
        `SELECT id, client_platform, client_name, created_at,
                COALESCE(last_used_at, created_at) AS last_active_at
         FROM user_sessions
         WHERE account_id = $1 AND status = 'active' AND expires_at > NOW()
         ORDER BY COALESCE(last_used_at, created_at) DESC, created_at DESC
         LIMIT $2`,
        [accountId, env.MAX_SESSIONS_PER_ACCOUNT],
    );
    return result.rows.map(row => ({
        id: row.id,
        platform: row.client_platform,
        name: row.client_name,
        created_at: new Date(row.created_at).toISOString(),
        last_active_at: new Date(row.last_active_at).toISOString(),
        current: row.id === currentSessionId,
    }));
}

export async function revokeSession(app: FastifyInstance, accountId: string, sessionId: string) {
    const client = await app.pg.connect();
    try {
        await client.query('BEGIN');
        const result = await client.query(
            `UPDATE user_sessions SET status = 'revoked'
             WHERE id = $2 AND account_id = $1 AND status = 'active'
             RETURNING client_platform, client_name`,
            [accountId, sessionId],
        );
        const session = result.rows[0];
        if (!session) throw httpError(404, 'SESSION_NOT_FOUND', 'Session not found');
        await recordAudit(client, {
            actorAccountId: accountId,
            action: 'account.session_revoked',
            metadata: { platform: session.client_platform, name: session.client_name },
        });
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
    await publishSessionsRevoked(app, accountId, [sessionId]);
}

export async function revokeOtherSessions(
    app: FastifyInstance,
    accountId: string,
    currentSessionId: string,
): Promise<number> {
    const client = await app.pg.connect();
    let revokedIds: string[] = [];
    try {
        await client.query('BEGIN');
        const result = await client.query(
            `UPDATE user_sessions SET status = 'revoked'
             WHERE account_id = $1 AND status = 'active' AND id <> $2
             RETURNING id`,
            [accountId, currentSessionId],
        );
        revokedIds = result.rows.map(row => row.id);
        if (revokedIds.length > 0) {
            await recordAudit(client, {
                actorAccountId: accountId,
                action: 'account.other_sessions_revoked',
                metadata: { count: revokedIds.length },
            });
        }
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
    await publishSessionsRevoked(app, accountId, revokedIds);
    return revokedIds.length;
}

/**
 * Permanently deletes the account. Owners must remove their devices first
 * (unpairing wipes camera recordings and returns the device to factory
 * state, which should be a deliberate step). Access to other people's
 * devices is withdrawn, pending invitations to this e-mail are cancelled and
 * every session is closed. Audit rows stay, anonymised by the foreign key.
 */
export async function deleteAccount(app: FastifyInstance, accountId: string, password: string) {
    const account = await verifyPassword(app, accountId, password);
    const client = await app.pg.connect();
    const changes: AccessChange[] = [];
    try {
        await client.query('BEGIN');
        const locked = await client.query(
            `SELECT 1 FROM accounts WHERE id = $1 AND status = 'active' FOR UPDATE`,
            [accountId],
        );
        if (!locked.rows[0]) throw httpError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');

        const owned = await client.query(
            `SELECT count(*)::int AS count FROM device_metadata WHERE owner_id = $1 AND is_active = true`,
            [accountId],
        );
        if (owned.rows[0].count > 0) {
            throw httpError(
                409,
                'ACCOUNT_OWNS_DEVICES',
                `Remove the ${owned.rows[0].count} device(s) you own before deleting the account`,
            );
        }

        const memberships = await client.query(
            `DELETE FROM device_memberships
             WHERE account_id = $1 AND role <> 'owner'
             RETURNING device_id`,
            [accountId],
        );
        for (const row of memberships.rows) {
            changes.push(await queueAccessProjection(client, app.catalog, row.device_id, [accountId]));
        }
        await client.query(
            `UPDATE device_invites SET status = 'revoked'
             WHERE lower(invited_email) = $1 AND status = 'pending'`,
            [account.email],
        );
        await client.query('DELETE FROM accounts WHERE id = $1', [accountId]);
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }

    await publishAccessChanges(app, changes);
    await publishSessionsRevoked(app, accountId, 'all');
}
