import './setup-env';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import accountRoutes from '../src/modules/account/routes';
import { createTestDatabase, skipWithoutDatabase, TestDatabase } from './helpers/testDatabase';
import { buildTestApp, signIn, signUp } from './helpers/testApp';

let db: TestDatabase;
let app: FastifyInstance;

test.describe('account center: profile and sessions foundation', { skip: skipWithoutDatabase }, () => {
    test.before(async () => {
        db = await createTestDatabase();
        app = await buildTestApp(db.pool, [accountRoutes]);
    });
    test.after(async () => {
        await app?.close();
        await db?.drop();
    });

    test('login stores the client, hashes the refresh token and binds the access token to the session', async () => {
        const user = await signUp(app);
        const web = await signIn(app, user.email, user.password, { platform: 'web', name: 'Chrome · Windows' });
        const row = (await db.pool.query(
            'SELECT refresh_token_hash, client_platform, client_name FROM user_sessions WHERE id = $1',
            [web.sessionId],
        )).rows[0];
        assert.equal(row.client_platform, 'web');
        assert.equal(row.client_name, 'Chrome · Windows');
        assert.match(row.refresh_token_hash, /^[0-9a-f]{64}$/);
        assert.notEqual(row.refresh_token_hash, web.refreshToken);
        const claims = app.jwt.decode(web.accessToken) as { sid: string };
        assert.equal(claims.sid, web.sessionId);
    });

    test('a signed-out session cannot keep using its unexpired access token', async () => {
        const user = await signUp(app);
        assert.equal((await app.inject({ method: 'GET', url: '/me', headers: user.headers })).statusCode, 200);
        const logout = await app.inject({
            method: 'POST',
            url: '/auth/logout',
            payload: { session_id: user.sessionId, refresh_token: user.refreshToken },
        });
        assert.equal(logout.statusCode, 200);
        const after = await app.inject({ method: 'GET', url: '/me', headers: user.headers });
        assert.equal(after.statusCode, 401);
        assert.equal(after.json().error.code, 'ACCESS_TOKEN_REVOKED');
    });

    test('refresh rotates the token and keeps the same session', async () => {
        const user = await signUp(app);
        const refresh = await app.inject({
            method: 'POST',
            url: '/auth/refresh',
            payload: { session_id: user.sessionId, refresh_token: user.refreshToken },
        });
        assert.equal(refresh.statusCode, 200);
        const body = refresh.json();
        assert.equal(body.session_id, user.sessionId);
        assert.notEqual(body.refresh_token, user.refreshToken);
        const reuse = await app.inject({
            method: 'POST',
            url: '/auth/refresh',
            payload: { session_id: user.sessionId, refresh_token: user.refreshToken },
        });
        assert.equal(reuse.statusCode, 401);
        const me = await app.inject({
            method: 'GET',
            url: '/me',
            headers: { authorization: `Bearer ${body.access_token}` },
        });
        assert.equal(me.statusCode, 200);
    });

    test('a token without a session id is rejected', async () => {
        const user = await signUp(app);
        const legacy = app.jwt.sign({ userId: user.id, email: user.email, tokenVersion: 1 });
        const response = await app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${legacy}` } });
        assert.equal(response.statusCode, 401);
        assert.equal(response.json().error.code, 'INVALID_ACCESS_TOKEN');
    });

    test('GET /me returns the profile and zero counters for a new account', async () => {
        const user = await signUp(app, { fullName: 'Nguyễn Văn A' });
        const response = await app.inject({ method: 'GET', url: '/me', headers: user.headers });
        assert.equal(response.statusCode, 200);
        const body = response.json();
        assert.equal(body.user.full_name, 'Nguyễn Văn A');
        assert.equal(body.user.email, user.email);
        assert.ok(Date.parse(body.user.created_at));
        assert.deepEqual(body.stats, { owned_devices: 0, shared_devices: 0, pending_invites: 0 });
    });

    test('PATCH /me renames the account, normalises spaces and records the change', async () => {
        const user = await signUp(app);
        const response = await app.inject({
            method: 'PATCH',
            url: '/me',
            headers: user.headers,
            payload: { full_name: '  Trần   Thị\tB  ' },
        });
        assert.equal(response.statusCode, 200);
        assert.equal(response.json().user.full_name, 'Trần Thị B');
        const audit = await db.pool.query(
            `SELECT action, metadata FROM device_audit_logs WHERE actor_account_id = $1`,
            [user.id],
        );
        assert.deepEqual(audit.rows, [{ action: 'account.profile_updated', metadata: { full_name: 'Trần Thị B' } }]);
    });

    test('PATCH /me rejects an empty name and unknown fields', async () => {
        const user = await signUp(app);
        for (const payload of [{ full_name: '   ' }, { full_name: 'x'.repeat(121) }, { full_name: 'A', email: 'x@y.z' }]) {
            const response = await app.inject({ method: 'PATCH', url: '/me', headers: user.headers, payload });
            assert.equal(response.statusCode, 400, JSON.stringify(payload));
            assert.equal(response.json().error.code, 'VALIDATION_ERROR');
        }
    });
});
