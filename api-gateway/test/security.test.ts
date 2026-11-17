import './setup-env';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { REDIS_CHANNELS } from '../../shared/constants';
import accountRoutes from '../src/modules/account/routes';
import { createTestDatabase, skipWithoutDatabase, TestDatabase } from './helpers/testDatabase';
import { buildTestApp, recordPublishes, signIn, signUp } from './helpers/testApp';
import { addMember, createOwnedDevice } from './helpers/fixtures';

let db: TestDatabase;
let app: FastifyInstance;
let published: Array<{ channel: string; payload: any }>;

const me = (headers: Record<string, string>) => app.inject({ method: 'GET', url: '/me', headers });

test.describe('account security', { skip: skipWithoutDatabase }, () => {
    test.before(async () => {
        db = await createTestDatabase();
        app = await buildTestApp(db.pool, [accountRoutes]);
        published = recordPublishes(app);
    });
    test.after(async () => {
        await app?.close();
        await db?.drop();
    });

    test('changing the password keeps this session, signs out the others and invalidates old tokens', async () => {
        const phone = await signUp(app);
        const laptop = await signIn(app, phone.email, phone.password, { platform: 'windows', name: 'Laptop' });

        const wrong = await app.inject({
            method: 'POST', url: '/me/password', headers: phone.headers,
            payload: { current_password: 'not my password', new_password: 'brand new password' },
        });
        assert.equal(wrong.statusCode, 403);
        assert.equal(wrong.json().error.code, 'INVALID_PASSWORD');

        const same = await app.inject({
            method: 'POST', url: '/me/password', headers: phone.headers,
            payload: { current_password: phone.password, new_password: phone.password },
        });
        assert.equal(same.json().error.code, 'PASSWORD_UNCHANGED');

        published.length = 0;
        const changed = await app.inject({
            method: 'POST', url: '/me/password', headers: phone.headers,
            payload: { current_password: phone.password, new_password: 'brand new password' },
        });
        assert.equal(changed.statusCode, 200);
        const body = changed.json();
        assert.equal(body.signed_out_sessions, 1);

        assert.equal((await me(phone.headers)).statusCode, 401, 'old access token of this session');
        assert.equal((await me({ authorization: `Bearer ${body.access_token}` })).statusCode, 200);
        assert.equal((await me(laptop.headers)).statusCode, 401, 'other session');
        const laptopRefresh = await app.inject({
            method: 'POST', url: '/auth/refresh',
            payload: { session_id: laptop.sessionId, refresh_token: laptop.refreshToken },
        });
        assert.equal(laptopRefresh.statusCode, 401);
        const phoneRefresh = await app.inject({
            method: 'POST', url: '/auth/refresh',
            payload: { session_id: phone.sessionId, refresh_token: phone.refreshToken },
        });
        assert.equal(phoneRefresh.statusCode, 200, 'this session keeps working');

        await assert.rejects(signIn(app, phone.email, phone.password));
        await signIn(app, phone.email, 'brand new password');
        assert.deepEqual(
            published.filter(item => item.channel === REDIS_CHANNELS.ACCOUNT_SESSIONS_REVOKED).map(item => item.payload),
            [{ account_id: phone.id, session_ids: [laptop.sessionId] }],
        );
    });

    test('sessions can be listed and signed out one by one or all others at once', async () => {
        const current = await signUp(app);
        const web = await signIn(app, current.email, current.password, { platform: 'web', name: 'Trình duyệt web · Windows' });
        const android = await signIn(app, current.email, current.password, { platform: 'android', name: 'Ứng dụng SmartHome · Android' });

        const list = await app.inject({ method: 'GET', url: '/me/sessions', headers: current.headers });
        assert.equal(list.statusCode, 200);
        const sessions = list.json().sessions as Array<{ id: string; platform: string; name: string | null; current: boolean }>;
        assert.equal(sessions.length, 3);
        assert.deepEqual(sessions.filter(s => s.current).map(s => s.id), [current.sessionId]);
        assert.equal(sessions.find(s => s.id === web.sessionId)?.name, 'Trình duyệt web · Windows');

        const revoke = await app.inject({ method: 'DELETE', url: `/me/sessions/${web.sessionId}`, headers: current.headers });
        assert.equal(revoke.statusCode, 200);
        assert.equal((await me(web.headers)).statusCode, 401);
        assert.equal((await me(android.headers)).statusCode, 200);

        const stranger = await signUp(app);
        const foreign = await app.inject({ method: 'DELETE', url: `/me/sessions/${android.sessionId}`, headers: stranger.headers });
        assert.equal(foreign.statusCode, 404, 'cannot sign out another account');

        const others = await app.inject({ method: 'POST', url: '/me/sessions/revoke-others', headers: current.headers });
        assert.equal(others.json().signed_out_sessions, 1);
        assert.equal((await me(android.headers)).statusCode, 401);
        assert.equal((await me(current.headers)).statusCode, 200);

        const actions = await db.pool.query(
            `SELECT action FROM device_audit_logs WHERE actor_account_id = $1 ORDER BY id`,
            [current.id],
        );
        assert.deepEqual(actions.rows.map(row => row.action), ['account.session_revoked', 'account.other_sessions_revoked']);
    });

    test('signing in beyond the session limit signs out the least recently used session', async () => {
        const user = await signUp(app);
        // 19 more sessions used earlier than the current one (20 in total, the limit).
        await db.pool.query(
            `INSERT INTO user_sessions (account_id, refresh_token_hash, client_platform, expires_at, last_used_at)
             SELECT $1, md5(n::text) || md5((n + 1000)::text), 'web', NOW() + INTERVAL '1 day',
                    NOW() - (n || ' minutes')::interval
             FROM generate_series(1, 19) AS n`,
            [user.id],
        );
        await db.pool.query(
            `UPDATE user_sessions SET last_used_at = NOW() - INTERVAL '1 hour' WHERE id = $1`,
            [user.sessionId],
        );
        const newest = await signIn(app, user.email, user.password);
        const active = await db.pool.query(
            `SELECT count(*)::int AS count FROM user_sessions WHERE account_id = $1 AND status = 'active'`,
            [user.id],
        );
        assert.equal(active.rows[0].count, 20);
        assert.equal((await me(user.headers)).statusCode, 401, 'the least recently used session was signed out');
        assert.equal((await me(newest.headers)).statusCode, 200);
    });

    test('a rate-limited request answers 429 with a stable error code', async () => {
        const user = await signUp(app);
        let response;
        for (let i = 0; i < 6; i++) {
            response = await app.inject({
                method: 'POST', url: '/auth/login', payload: { email: user.email, password: 'wrong password' },
            });
        }
        assert.equal(response!.statusCode, 429);
        assert.equal(response!.json().error.code, 'RATE_LIMITED');
    });

    test('deleting the account requires the password and no owned devices', async () => {
        const owner = await signUp(app);
        const device = await createOwnedDevice(db.pool, owner.id);

        const wrong = await app.inject({ method: 'DELETE', url: '/me', headers: owner.headers, payload: { password: 'wrong password' } });
        assert.equal(wrong.statusCode, 403);
        const blocked = await app.inject({ method: 'DELETE', url: '/me', headers: owner.headers, payload: { password: owner.password } });
        assert.equal(blocked.statusCode, 409);
        assert.equal(blocked.json().error.code, 'ACCOUNT_OWNS_DEVICES');
        assert.equal((await me(owner.headers)).statusCode, 200);
        assert.ok(device.id);
    });

    test('deleting the account withdraws shared access, cancels invitations and closes every session', async () => {
        const owner = await signUp(app);
        const device = await createOwnedDevice(db.pool, owner.id);
        const member = await signUp(app);
        await addMember(db.pool, device, owner.id, member.id, 'viewer', ['device.view', 'camera.view']);
        await db.pool.query(
            `INSERT INTO device_invites (device_id, invited_email, role, token_hash, invited_by, expires_at)
             VALUES ($1, $2, 'viewer', 'token-hash', $3, NOW() + INTERVAL '7 days')`,
            [(await createOwnedDevice(db.pool, owner.id)).id, member.email, owner.id],
        );
        await db.pool.query(
            `INSERT INTO device_audit_logs (actor_account_id, action, outcome) VALUES ($1, 'account.profile_updated', 'success')`,
            [member.id],
        );

        published.length = 0;
        const deleted = await app.inject({ method: 'DELETE', url: '/me', headers: member.headers, payload: { password: member.password } });
        assert.equal(deleted.statusCode, 200);

        assert.equal((await me(member.headers)).statusCode, 401);
        await assert.rejects(signIn(app, member.email, member.password));
        const left = await db.pool.query(
            `SELECT (SELECT count(*) FROM accounts WHERE id = $1)::int AS accounts,
                    (SELECT count(*) FROM device_memberships WHERE account_id = $1)::int AS memberships,
                    (SELECT count(*) FROM device_invites WHERE invited_email = $2 AND status = 'pending')::int AS invites,
                    (SELECT count(*) FROM device_audit_logs WHERE actor_account_id IS NULL)::int AS anonymised`,
            [member.id, member.email],
        );
        assert.deepEqual(left.rows[0], { accounts: 0, memberships: 0, invites: 0, anonymised: 1 });

        const outbox = await db.pool.query(
            `SELECT payload FROM device_shadow_outbox WHERE device_id = $1 AND operation = 'access'`,
            [device.id],
        );
        assert.deepEqual(outbox.rows[0].payload.access_grants.map((grant: any) => grant.account_id), [owner.id]);
        const channels = published.map(item => item.channel);
        assert.ok(channels.includes(REDIS_CHANNELS.DEVICE_ACCESS_CHANGED));
        assert.deepEqual(
            published.find(item => item.channel === REDIS_CHANNELS.ACCOUNT_SESSIONS_REVOKED)?.payload,
            { account_id: member.id, all: true },
        );
        assert.equal((await me(owner.headers)).statusCode, 200, 'the owner is unaffected');
    });
});
