import argon2 from 'argon2';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { httpError } from '../../utils/httpError';
import { type AdminActor, CLI, recordAdminAction } from './audit';
import { expandPermissions, type StaffIdentity, type StaffPermission } from './permissions';

/**
 * Staff of the Admin Console (docs/architecture/admin.md): the company's own
 * people, never customers. One root (made with tools/staff.ts) creates the
 * others with a temporary password and the permissions they need.
 *
 * Sessions: a random token in an httpOnly cookie of the Console (only its
 * SHA-256 is stored), ending when revoked, after 30 idle minutes or 12 hours.
 * Five wrong passwords lock the account for 15 minutes.
 */

export const SESSION_IDLE_MINUTES = 30;
export const SESSION_HOURS = 12;
export const MAX_SESSIONS = 10;
export const LOCK_AFTER_FAILURES = 5;
export const LOCK_MINUTES = 15;
export const PASSWORD_MIN = 10;

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export interface StaffSession extends StaffIdentity {
    session_id: string;
    must_change_password: boolean;
}

export const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

/** "kq7m-4xpd-9wrt": easy to read out, no 0/O or 1/l. */
export function temporaryPassword(): string {
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    const part = () => Array.from({ length: 4 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
    return `${part()}-${part()}-${part()}`;
}

const normalizeEmail = (email: string) => email.trim().toLowerCase();

let dummyHash: Promise<string> | null = null;
/** Verifying against a throwaway hash keeps "no such e-mail" as slow as "wrong password". */
const slowNo = (password: string) => {
    dummyHash ??= argon2.hash(crypto.randomBytes(16).toString('hex'));
    return dummyHash.then(hash => argon2.verify(hash, password)).then(() => false);
};

function identity(row: any): StaffIdentity {
    return {
        id: row.id,
        email: row.email,
        full_name: row.full_name,
        is_root: row.is_root === true,
        permissions: expandPermissions(row.permissions ?? []),
    };
}

export function actorOf(staff: Pick<StaffIdentity, 'id' | 'email'>): AdminActor {
    return { kind: 'staff', id: staff.id, email: staff.email };
}

/** The signed-in staff member behind a session token, or null (unknown, revoked, idle, expired, disabled). */
export async function loadStaffSession(app: FastifyInstance, token: unknown): Promise<StaffSession | null> {
    if (typeof token !== 'string' || !TOKEN.test(token)) return null;
    const result = await app.pg.query(
        `SELECT session.id AS session_id, session.last_used_at < NOW() - interval '1 minute' AS stale,
                staff.id, staff.email, staff.full_name, staff.is_root, staff.permissions, staff.must_change_password
         FROM staff_sessions AS session
         JOIN staff_accounts AS staff ON staff.id = session.staff_id AND staff.status = 'active'
         WHERE session.token_hash = $1 AND session.status = 'active' AND session.expires_at > NOW()
           AND session.last_used_at > NOW() - make_interval(mins => $2)`,
        [hashToken(token), SESSION_IDLE_MINUTES],
    );
    const row = result.rows[0];
    if (!row) return null;
    // At most one write a minute per session keeps the idle clock without a write per request.
    if (row.stale) await app.pg.query('UPDATE staff_sessions SET last_used_at = NOW() WHERE id = $1', [row.session_id]);
    return { ...identity(row), session_id: row.session_id, must_change_password: row.must_change_password === true };
}

async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

export async function loginStaff(
    app: FastifyInstance,
    input: { email: string; password: string; client?: string; ip?: string },
) {
    const email = normalizeEmail(input.email);
    const row = (await app.pg.query(
        `SELECT id, email, full_name, is_root, permissions, password_hash, status, must_change_password,
                locked_until > NOW() AS locked, GREATEST(0, EXTRACT(EPOCH FROM locked_until - NOW()))::int AS locked_seconds
         FROM staff_accounts WHERE email = $1`,
        [email],
    )).rows[0];
    if (!row) {
        await slowNo(input.password);
        throw httpError(401, 'STAFF_INVALID_CREDENTIALS', 'Email hoặc mật khẩu không đúng.');
    }
    if (row.locked) {
        const error = httpError(429, 'STAFF_LOCKED', `Đăng nhập sai nhiều lần. Thử lại sau ${Math.ceil(row.locked_seconds / 60)} phút.`) as any;
        error.details = { retry_after_seconds: row.locked_seconds };
        throw error;
    }
    if (!(await argon2.verify(row.password_hash, input.password))) {
        const failed = (await app.pg.query(
            `UPDATE staff_accounts
             SET failed_logins = CASE WHEN failed_logins + 1 >= $2 THEN 0 ELSE failed_logins + 1 END,
                 locked_until = CASE WHEN failed_logins + 1 >= $2 THEN NOW() + make_interval(mins => $3) ELSE locked_until END
             WHERE id = $1 RETURNING locked_until > NOW() AS locked`,
            [row.id, LOCK_AFTER_FAILURES, LOCK_MINUTES],
        )).rows[0];
        if (failed?.locked) throw httpError(429, 'STAFF_LOCKED', `Đăng nhập sai ${LOCK_AFTER_FAILURES} lần. Thử lại sau ${LOCK_MINUTES} phút.`);
        throw httpError(401, 'STAFF_INVALID_CREDENTIALS', 'Email hoặc mật khẩu không đúng.');
    }
    if (row.status !== 'active') throw httpError(403, 'STAFF_DISABLED', 'Tài khoản nhân viên đã bị khóa.');

    const token = crypto.randomBytes(32).toString('base64url');
    const session = await inTransaction(app.pg, async (client) => {
        await client.query(
            'UPDATE staff_accounts SET failed_logins = 0, locked_until = NULL, last_login_at = NOW() WHERE id = $1',
            [row.id],
        );
        const inserted = (await client.query(
            `INSERT INTO staff_sessions (staff_id, token_hash, client, ip, expires_at)
             VALUES ($1, $2, $3, $4, NOW() + make_interval(hours => $5))
             RETURNING id, expires_at`,
            [row.id, hashToken(token), input.client?.slice(0, 200) || null, input.ip?.slice(0, 64) || null, SESSION_HOURS],
        )).rows[0];
        // A bounded number of browsers per person: the oldest ones end.
        await client.query(
            `UPDATE staff_sessions SET status = 'revoked'
             WHERE staff_id = $1 AND status = 'active' AND id NOT IN (
                 SELECT id FROM staff_sessions WHERE staff_id = $1 AND status = 'active'
                 ORDER BY created_at DESC LIMIT $2)`,
            [row.id, MAX_SESSIONS],
        );
        return inserted;
    });
    return {
        session_token: token,
        expires_at: new Date(session.expires_at).toISOString(),
        idle_minutes: SESSION_IDLE_MINUTES,
        staff: { ...identity(row), must_change_password: row.must_change_password === true },
    };
}

export async function logoutStaff(app: FastifyInstance, sessionId: string) {
    await app.pg.query(`UPDATE staff_sessions SET status = 'revoked' WHERE id = $1`, [sessionId]);
}

function checkNewPassword(password: string) {
    if (password.length < PASSWORD_MIN || password.length > 128) {
        throw httpError(400, 'STAFF_PASSWORD_WEAK', `Mật khẩu cần từ ${PASSWORD_MIN} đến 128 ký tự.`);
    }
}

/** Own password: the current one is required; other browsers are signed out. */
export async function changeOwnPassword(
    app: FastifyInstance,
    staff: StaffSession,
    input: { current_password: string; new_password: string },
) {
    checkNewPassword(input.new_password);
    const row = (await app.pg.query('SELECT password_hash FROM staff_accounts WHERE id = $1', [staff.id])).rows[0];
    if (!row || !(await argon2.verify(row.password_hash, input.current_password))) {
        throw httpError(400, 'STAFF_PASSWORD_WRONG', 'Mật khẩu hiện tại không đúng.');
    }
    if (input.new_password === input.current_password) {
        throw httpError(400, 'STAFF_PASSWORD_SAME', 'Mật khẩu mới phải khác mật khẩu hiện tại.');
    }
    const hash = await argon2.hash(input.new_password);
    await inTransaction(app.pg, async (client) => {
        await client.query(
            'UPDATE staff_accounts SET password_hash = $2, must_change_password = false WHERE id = $1',
            [staff.id, hash],
        );
        await client.query(
            `UPDATE staff_sessions SET status = 'revoked' WHERE staff_id = $1 AND status = 'active' AND id <> $2`,
            [staff.id, staff.session_id],
        );
    });
}

export async function listOwnSessions(app: FastifyInstance, staff: StaffSession) {
    const result = await app.pg.query(
        `SELECT id, client, ip, created_at, last_used_at, expires_at FROM staff_sessions
         WHERE staff_id = $1 AND status = 'active' AND expires_at > NOW()
           AND last_used_at > NOW() - make_interval(mins => $2)
         ORDER BY last_used_at DESC`,
        [staff.id, SESSION_IDLE_MINUTES],
    );
    return result.rows.map(row => ({
        id: row.id as string,
        client: row.client as string | null,
        ip: row.ip as string | null,
        created_at: new Date(row.created_at).toISOString(),
        last_used_at: new Date(row.last_used_at).toISOString(),
        expires_at: new Date(row.expires_at).toISOString(),
        current: row.id === staff.session_id,
    }));
}

export async function revokeOtherOwnSessions(app: FastifyInstance, staff: StaffSession): Promise<number> {
    const result = await app.pg.query(
        `UPDATE staff_sessions SET status = 'revoked' WHERE staff_id = $1 AND status = 'active' AND id <> $2 RETURNING id`,
        [staff.id, staff.session_id],
    );
    return result.rows.length;
}

// ── Managed by the root ────────────────────────────────────────────────────

export async function listStaff(app: FastifyInstance) {
    const result = await app.pg.query(
        `SELECT staff.id, staff.email, staff.full_name, staff.is_root, staff.permissions, staff.status,
                staff.must_change_password, staff.locked_until > NOW() AS locked, staff.last_login_at, staff.created_at,
                (SELECT count(*)::int FROM staff_sessions AS session
                 WHERE session.staff_id = staff.id AND session.status = 'active' AND session.expires_at > NOW()
                   AND session.last_used_at > NOW() - make_interval(mins => $1)) AS sessions
         FROM staff_accounts AS staff
         ORDER BY staff.is_root DESC, staff.created_at`,
        [SESSION_IDLE_MINUTES],
    );
    return result.rows.map(row => ({
        ...identity(row),
        status: row.status as 'active' | 'disabled',
        must_change_password: row.must_change_password === true,
        locked: row.locked === true,
        last_login_at: row.last_login_at ? new Date(row.last_login_at).toISOString() : null,
        created_at: new Date(row.created_at).toISOString(),
        sessions: Number(row.sessions),
    }));
}

async function lockStaff(client: PoolClient, staffId: string) {
    const row = (await client.query(
        'SELECT id, email, full_name, is_root, permissions, status FROM staff_accounts WHERE id = $1 FOR UPDATE',
        [staffId],
    )).rows[0];
    if (!row) throw httpError(404, 'STAFF_NOT_FOUND', 'Không tìm thấy nhân viên.');
    if (row.is_root) throw httpError(409, 'STAFF_IS_ROOT', 'Admin gốc chỉ được đổi bằng lệnh trên máy chủ.');
    return row;
}

const endSessions = (client: PoolClient, staffId: string) =>
    client.query(`UPDATE staff_sessions SET status = 'revoked' WHERE staff_id = $1 AND status = 'active' RETURNING id`, [staffId])
        .then(result => result.rows.length);

/** A sub-admin with a temporary password (shown once) they must change at first sign-in. */
export async function createStaff(
    app: FastifyInstance,
    by: StaffSession,
    input: { email: string; full_name: string; permissions: StaffPermission[] },
) {
    const email = normalizeEmail(input.email);
    const permissions = expandPermissions(input.permissions);
    const password = temporaryPassword();
    const hash = await argon2.hash(password);
    const staff = await inTransaction(app.pg, async (client) => {
        const inserted = await client.query(
            `INSERT INTO staff_accounts (email, full_name, password_hash, permissions, created_by)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (email) DO NOTHING
             RETURNING id, email, full_name, is_root, permissions`,
            [email, input.full_name.trim(), hash, permissions, by.id],
        );
        if (!inserted.rows[0]) throw httpError(409, 'STAFF_EXISTS', 'Email này đã là nhân viên.');
        await recordAdminAction(client, {
            actor: actorOf(by), action: 'staff.created', reason: 'Tạo nhân viên mới',
            details: { staff: { id: inserted.rows[0].id, email }, permissions },
        });
        return identity(inserted.rows[0]);
    });
    return { staff, temporary_password: password };
}

export async function updateStaff(
    app: FastifyInstance,
    by: StaffSession,
    staffId: string,
    input: { full_name?: string; permissions?: StaffPermission[] },
) {
    return inTransaction(app.pg, async (client) => {
        const before = await lockStaff(client, staffId);
        const permissions = input.permissions ? expandPermissions(input.permissions) : expandPermissions(before.permissions);
        const updated = (await client.query(
            `UPDATE staff_accounts SET full_name = $2, permissions = $3 WHERE id = $1
             RETURNING id, email, full_name, is_root, permissions`,
            [staffId, input.full_name?.trim() || before.full_name, permissions],
        )).rows[0];
        await recordAdminAction(client, {
            actor: actorOf(by), action: 'staff.updated', reason: 'Đổi tên hoặc quyền nhân viên',
            details: {
                staff: { id: staffId, email: before.email },
                permissions_before: expandPermissions(before.permissions),
                permissions_after: permissions,
            },
        });
        return identity(updated);
    });
}

export type StaffAction = 'disable' | 'enable' | 'reset-password' | 'sign-out';

/** Lock, unlock, new temporary password, or sign out everywhere; the person's open Console ends at once. */
export async function actOnStaff(app: FastifyInstance, by: StaffSession, staffId: string, action: StaffAction, reason: string) {
    if (staffId === by.id) throw httpError(409, 'STAFF_IS_SELF', 'Dùng "Tài khoản của tôi" để đổi tài khoản của chính bạn.');
    const password = action === 'reset-password' ? temporaryPassword() : null;
    const hash = password ? await argon2.hash(password) : null;
    const signedOut = await inTransaction(app.pg, async (client) => {
        const staff = await lockStaff(client, staffId);
        if (action === 'disable') {
            if (staff.status === 'disabled') throw httpError(409, 'STAFF_NOT_ACTIVE', 'Nhân viên đã bị khóa.');
            await client.query(`UPDATE staff_accounts SET status = 'disabled' WHERE id = $1`, [staffId]);
        } else if (action === 'enable') {
            if (staff.status !== 'disabled') throw httpError(409, 'STAFF_NOT_DISABLED', 'Nhân viên không bị khóa.');
            await client.query(
                `UPDATE staff_accounts SET status = 'active', failed_logins = 0, locked_until = NULL WHERE id = $1`,
                [staffId],
            );
        } else if (action === 'reset-password') {
            await client.query(
                `UPDATE staff_accounts SET password_hash = $2, must_change_password = true, failed_logins = 0, locked_until = NULL
                 WHERE id = $1`,
                [staffId, hash],
            );
        }
        const count = action === 'enable' ? 0 : await endSessions(client, staffId);
        await recordAdminAction(client, {
            actor: actorOf(by),
            action: ({ disable: 'staff.disabled', enable: 'staff.enabled', 'reset-password': 'staff.password_reset', 'sign-out': 'staff.signed_out' } as const)[action],
            reason,
            details: { staff: { id: staffId, email: staff.email }, signed_out_sessions: count },
        });
        return count;
    });
    return { signed_out_sessions: signedOut, ...(password ? { temporary_password: password } : {}) };
}

// ── The root, from tools/staff.ts ──────────────────────────────────────────

/** The one root, with a temporary password printed by the CLI. */
export async function createRootStaff(pg: Pool, input: { email: string; full_name: string }) {
    const password = temporaryPassword();
    const hash = await argon2.hash(password);
    const id = await inTransaction(pg, async (client) => {
        const root = await client.query('SELECT 1 FROM staff_accounts WHERE is_root');
        if (root.rows[0]) throw httpError(409, 'STAFF_ROOT_EXISTS', 'Đã có admin gốc. Dùng reset-root nếu quên mật khẩu.');
        const email = normalizeEmail(input.email);
        const inserted = await client.query(
            `INSERT INTO staff_accounts (email, full_name, password_hash, is_root)
             VALUES ($1, $2, $3, true) ON CONFLICT (email) DO NOTHING RETURNING id`,
            [email, input.full_name.trim(), hash],
        );
        if (!inserted.rows[0]) throw httpError(409, 'STAFF_EXISTS', 'Email này đã là nhân viên.');
        await recordAdminAction(client, {
            actor: CLI, action: 'staff.created', reason: 'Tạo admin gốc bằng lệnh staff.js',
            details: { staff: { id: inserted.rows[0].id, email }, root: true },
        });
        return inserted.rows[0].id as string;
    });
    return { id, temporary_password: password };
}

/** Forgotten root password: a new temporary one, every root session ends, the lock is lifted. */
export async function resetRootStaff(pg: Pool) {
    const password = temporaryPassword();
    const hash = await argon2.hash(password);
    const email = await inTransaction(pg, async (client) => {
        const root = (await client.query('SELECT id, email FROM staff_accounts WHERE is_root FOR UPDATE')).rows[0];
        if (!root) throw httpError(404, 'STAFF_NO_ROOT', 'Chưa có admin gốc. Dùng create-root.');
        await client.query(
            `UPDATE staff_accounts SET password_hash = $2, must_change_password = true, failed_logins = 0, locked_until = NULL
             WHERE id = $1`,
            [root.id, hash],
        );
        await endSessions(client, root.id);
        await recordAdminAction(client, {
            actor: CLI, action: 'staff.password_reset', reason: 'Đặt lại mật khẩu admin gốc bằng lệnh staff.js',
            details: { staff: { id: root.id, email: root.email } },
        });
        return root.email as string;
    });
    return { email, temporary_password: password };
}
