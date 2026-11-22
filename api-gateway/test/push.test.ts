import './setup-env';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { REDIS_CHANNELS } from '../../shared/constants';
import { env } from '../src/config/env';
import { fcmPayload, resetPushCredentials } from '../src/modules/push/fcm';
import { TITLED_EVENTS, eventTitle } from '../src/modules/push/labels';
import pushRoutes from '../src/modules/push/routes';
import { accountPushFrom, deviceAlertFrom } from '../src/modules/push/service';
import { sendPlanReminders } from '../src/modules/payments/reminders';
import { PushNotifier } from '../src/workers/pushNotifier';
import { createTestDatabase, skipWithoutDatabase, TestDatabase } from './helpers/testDatabase';
import { buildTestApp, recordPublishes, signUp, SignedInUser } from './helpers/testApp';
import { addMember, createOwnedDevice } from './helpers/fixtures';

const deviceEvent = (mac: string, payload: Record<string, unknown>) => JSON.stringify({
    owner_id: 'x', mac, payload: { data: {}, ...payload }, timestamp: new Date().toISOString(),
});
const accountEvent = (accountId: string, event: string, data: object) => JSON.stringify({ account_id: accountId, event, data });

test('every warning or critical event of the catalog has a Vietnamese title', () => {
    const capabilities = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'database', 'catalog-v2', 'capabilities.json'), 'utf8'));
    const alerts = (capabilities as any[]).flatMap(capability => (capability.events ?? [])
        .filter((event: any) => event.severity === 'warning' || event.severity === 'critical')
        .map((event: any) => event.id as string));
    assert.ok(alerts.length >= 10);
    for (const id of alerts) assert.ok(TITLED_EVENTS.includes(id), `no title for ${id}`);
    assert.equal(eventTitle('incident_started', { cause: 'gas' }), 'Báo động: rò rỉ khí gas');
    assert.equal(eventTitle('water_availability_changed', { to: 'empty' }), 'Bể nước đã cạn');
});

test('what a device event or an account event becomes', () => {
    assert.equal(deviceAlertFrom({ mac: 'AA:00:00:00:00:01', payload: { event_name: 'door_opened', severity: 'info' } }), null);
    const gas = deviceAlertFrom({
        mac: 'AA:00:00:00:00:01',
        payload: { event_name: 'gas_threshold_crossed', severity: 'critical', capability_id: 'gas_measurement' },
    })!;
    assert.equal(gas.category, 'safety', 'the category is derived when the message has none');
    assert.equal(gas.message.channel, 'alerts');
    assert.equal(gas.message.route, '/device/AA:00:00:00:00:01');
    const rain = deviceAlertFrom({ mac: 'AA:00:00:00:00:02', payload: { event_name: 'rain_started', severity: 'warning', category: 'outdoor' } })!;
    assert.equal(rain.message.channel, 'general');

    const paid = accountPushFrom({
        account_id: 'acc', event: 'payment_updated',
        data: { order: { code: 'SHABCD2345', status: 'paid', plan: { name: 'Cơ bản' }, plan_expires_at: '2026-12-22T05:00:00Z' } },
    })!;
    assert.equal(paid.message.title, 'Thanh toán thành công');
    assert.match(paid.message.body, /^Gói Cơ bản đã được kích hoạt đến \d{2}\/\d{2}\/2026\.$/);
    const partial = accountPushFrom({
        account_id: 'acc', event: 'payment_updated',
        data: { order: { code: 'SHABCD2345', status: 'review', amount_vnd: 49000, received_vnd: 20000 } },
    })!;
    assert.match(partial.message.body, /còn thiếu 29\.000đ/);
    assert.equal(accountPushFrom({ account_id: 'acc', event: 'payment_updated', data: { order: { status: 'pending' } } }), null);
    assert.equal(accountPushFrom({ account_id: 'acc', event: 'notification_created', data: { notification: { kind: 'security', body: 'Khóa giọng nói 15 phút' } } })!.message.channel, 'alerts');
    assert.equal(accountPushFrom({ account_id: 'acc', event: 'sharing_invite_received', data: { owner_name: 'Lâm', device_name: 'Cửa chính' } })!.message.body,
        'Lâm mời bạn dùng chung "Cửa chính".');
    assert.equal(accountPushFrom({ account_id: 'acc', event: 'plan_expiring', data: { plan: { code: 'basic', name: 'Cơ bản' }, expires_at: '2026-12-22T05:00:00Z' } })!.message.route,
        '/assistant?renew=basic');
    assert.equal(accountPushFrom({ account_id: 'acc', event: 'scene_run_updated', data: {} }), null);

    const payload = fcmPayload('token-1', { ...gas.message, body: 'Bếp' });
    assert.equal(payload.message.android.priority, 'HIGH');
    assert.equal(payload.message.android.notification.channel_id, 'alerts');
    assert.equal(payload.message.data.route, '/device/AA:00:00:00:00:01');
});

test.describe('push notifications', { skip: skipWithoutDatabase }, () => {
    let db: TestDatabase;
    let app: FastifyInstance;
    let server: http.Server;
    let notifier: PushNotifier;
    let file: string;
    const sent: any[] = [];
    const dead = new Set<string>();
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

    test.before(async () => {
        db = await createTestDatabase();
        app = await buildTestApp(db.pool, [pushRoutes]);
        server = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on('data', chunk => chunks.push(chunk));
            req.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                const reply = (status: number, value: object) => {
                    res.writeHead(status, { 'content-type': 'application/json' });
                    res.end(JSON.stringify(value));
                };
                if (req.url === '/token') {
                    // The Gateway's own RS256 assertion, checked with the service account's public key.
                    const assertion = new URLSearchParams(body).get('assertion') ?? '';
                    const [header, claims, signature] = assertion.split('.');
                    const valid = crypto.verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature ?? '', 'base64url'));
                    const scope = JSON.parse(Buffer.from(claims ?? '', 'base64url').toString('utf8') || '{}').scope;
                    return valid && scope === 'https://www.googleapis.com/auth/firebase.messaging'
                        ? reply(200, { access_token: 'access-1', expires_in: 3600 })
                        : reply(400, { error: 'invalid_grant' });
                }
                if (req.url === '/v1/projects/demo-project/messages:send' && req.headers.authorization === 'Bearer access-1') {
                    const message = JSON.parse(body).message;
                    if (dead.has(message.token)) {
                        return reply(404, { error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } });
                    }
                    sent.push(message);
                    return reply(200, { name: 'projects/demo-project/messages/1' });
                }
                return reply(401, { error: { status: 'UNAUTHENTICATED' } });
            });
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'push-')), 'service-account.json');
        fs.writeFileSync(file, JSON.stringify({
            type: 'service_account', project_id: 'demo-project', client_email: 'push@demo-project.iam.gserviceaccount.com',
            private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: `${base}/token`,
        }));
        Object.assign(env, { FCM_SERVICE_ACCOUNT_FILE: file, FCM_API_URL: base, PUSH_EVENT_THROTTLE_SECONDS: 60 });
        resetPushCredentials();
        notifier = new PushNotifier(app);
    });
    test.after(async () => {
        Object.assign(env, { FCM_SERVICE_ACCOUNT_FILE: '' });
        resetPushCredentials();
        await app?.close();
        await new Promise(resolve => server?.close(resolve));
        await db?.drop();
    });
    test.beforeEach(() => {
        sent.length = 0;
    });

    const register = (user: SignedInUser, token: string) => app.inject({
        method: 'PUT', url: '/me/push-tokens', headers: user.headers, payload: { token, platform: 'android' },
    });

    test('alerts reach the device\'s members who did not mute them, once across Gateways', async () => {
        const owner = await signUp(app);
        const member = await signUp(app);
        const registered = await register(owner, 'owner-phone-token-00000001');
        assert.equal(registered.statusCode, 200, registered.body);
        assert.equal(registered.json().push_enabled, true);
        assert.equal((await register(member, 'member-phone-token-0000001')).statusCode, 200);
        const kitchen = await createOwnedDevice(db.pool, owner.id, { name: 'Bếp' });
        await addMember(db.pool, kitchen, owner.id, member.id);
        await db.pool.query(
            `INSERT INTO account_preferences (account_id, muted_notification_categories) VALUES ($1, ARRAY['outdoor'])`,
            [member.id],
        );

        const gas = deviceEvent(kitchen.mac, {
            event_id: 'e-gas-1', event_name: 'gas_threshold_crossed', severity: 'critical', capability_id: 'gas_measurement', category: 'safety',
        });
        await notifier.handle(REDIS_CHANNELS.DEVICE_EVENT, gas);
        await notifier.handle(REDIS_CHANNELS.DEVICE_EVENT, gas);
        assert.deepEqual(sent.map(message => message.token).sort(), ['member-phone-token-0000001', 'owner-phone-token-00000001']);
        assert.deepEqual(sent[0].notification, { title: 'Khí gas vượt ngưỡng', body: 'Bếp' });
        assert.equal(sent[0].android.notification.channel_id, 'alerts');
        assert.equal(sent[0].data.route, `/device/${kitchen.mac}`);

        sent.length = 0;
        await notifier.handle(REDIS_CHANNELS.DEVICE_EVENT, deviceEvent(kitchen.mac, {
            event_id: 'e-rain-1', event_name: 'rain_started', severity: 'warning', capability_id: 'rain_detection', category: 'outdoor',
        }));
        assert.deepEqual(sent.map(message => message.token), ['owner-phone-token-00000001'], 'the member muted outdoor alerts');
        assert.equal(sent[0].android.notification.channel_id, 'general');

        sent.length = 0;
        await notifier.handle(REDIS_CHANNELS.DEVICE_EVENT, deviceEvent(kitchen.mac, {
            event_id: 'e-rain-2', event_name: 'rain_started', severity: 'warning', capability_id: 'rain_detection', category: 'outdoor',
        }));
        await notifier.handle(REDIS_CHANNELS.DEVICE_EVENT, deviceEvent(kitchen.mac, {
            event_id: 'e-info-1', event_name: 'pump_started', severity: 'info', capability_id: 'irrigation_pump',
        }));
        assert.equal(sent.length, 0, 'the same alert within a minute and informational events are not pushed');
    });

    test('account events go to that account; dead tokens and signed-out sessions stop receiving', async () => {
        const user = await signUp(app);
        await register(user, 'user-phone-token-000000001');
        const paid = accountEvent(user.id, 'payment_updated', {
            order: { code: 'SHABCD2345', status: 'paid', plan: { code: 'basic', name: 'Cơ bản' }, plan_expires_at: new Date().toISOString() },
        });
        await notifier.handle(REDIS_CHANNELS.ACCOUNT_EVENT, paid);
        await notifier.handle(REDIS_CHANNELS.ACCOUNT_EVENT, paid);
        assert.equal(sent.length, 1);
        assert.equal(sent[0].notification.title, 'Thanh toán thành công');
        assert.equal(sent[0].data.route, '/profile/plans');
        await notifier.handle(REDIS_CHANNELS.ACCOUNT_EVENT, accountEvent(user.id, 'scene_run_updated', { run: {} }));
        assert.equal(sent.length, 1, 'scene progress is not pushed');

        // A phone the app was removed from: FCM says so and the token goes.
        await register(user, 'removed-phone-token-00001');
        dead.add('removed-phone-token-00001');
        await notifier.handle(REDIS_CHANNELS.ACCOUNT_EVENT, accountEvent(user.id, 'sharing_invite_received', { owner_name: 'Lâm', device_name: 'Cửa' }));
        const left = (await db.pool.query('SELECT token FROM push_tokens WHERE account_id = $1 ORDER BY token', [user.id])).rows;
        assert.deepEqual(left.map(row => row.token), ['user-phone-token-000000001']);

        // Signing out ends the session; its phone receives nothing more.
        const logout = await app.inject({
            method: 'POST', url: '/auth/logout', payload: { session_id: user.sessionId, refresh_token: user.refreshToken },
        });
        assert.equal(logout.statusCode, 200, logout.body);
        sent.length = 0;
        await notifier.handle(REDIS_CHANNELS.ACCOUNT_EVENT, accountEvent(user.id, 'plan_expired', { plan: { code: 'basic', name: 'Cơ bản' } }));
        assert.equal(sent.length, 0);
    });

    test('a test push, removing a phone, and push turned off', async () => {
        const user = await signUp(app);
        const none = await app.inject({ method: 'POST', url: '/me/push-tokens/test', headers: user.headers });
        assert.equal(none.json().error.code, 'PUSH_NO_DEVICE');
        await register(user, 'tester-phone-token-0000001');
        const tried = await app.inject({ method: 'POST', url: '/me/push-tokens/test', headers: user.headers });
        assert.equal(tried.statusCode, 200, tried.body);
        assert.equal(sent.at(-1).notification.title, 'Thông báo thử');
        const removed = await app.inject({
            method: 'DELETE', url: '/me/push-tokens', headers: user.headers, payload: { token: 'tester-phone-token-0000001' },
        });
        assert.equal(removed.statusCode, 200);
        assert.equal((await db.pool.query('SELECT 1 FROM push_tokens WHERE account_id = $1', [user.id])).rowCount, 0);
        assert.equal((await register(user, 'bad token with spaces!!')).statusCode, 400);

        Object.assign(env, { FCM_SERVICE_ACCOUNT_FILE: '' });
        resetPushCredentials();
        try {
            const off = await app.inject({ method: 'POST', url: '/me/push-tokens/test', headers: user.headers });
            assert.equal(off.json().error.code, 'PUSH_UNAVAILABLE');
        } finally {
            Object.assign(env, { FCM_SERVICE_ACCOUNT_FILE: file });
            resetPushCredentials();
        }
    });

    test('plan reminders: 3 days and 1 day before, once ended; each once; a new end date starts again', async () => {
        const user = await signUp(app);
        const remind = () => sendPlanReminders({ pg: db.pool, redis: app.redis, log: app.log });
        const setEnd = (interval: string) => db.pool.query(
            `INSERT INTO account_plans (account_id, plan_code, started_at, expires_at)
             VALUES ($1, 'basic', NOW() - interval '60 days', NOW() + $2::interval)
             ON CONFLICT (account_id) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
            [user.id, interval],
        );
        const published = recordPublishes(app);
        const mine = () => published.filter(item => item.channel === REDIS_CHANNELS.ACCOUNT_EVENT && item.payload.account_id === user.id);

        await setEnd('2 days 12 hours');
        await remind();
        await remind();
        assert.deepEqual(mine().map(item => [item.payload.event, item.payload.data.stage]), [['plan_expiring', '3d']]);
        assert.deepEqual(mine()[0].payload.data.plan, { code: 'basic', name: 'Cơ bản' });

        await setEnd('10 hours');
        await remind();
        assert.deepEqual(mine().map(item => item.payload.data.stage), ['3d', '1d']);

        await setEnd('-2 hours');
        await remind();
        assert.equal(mine().at(-1)!.payload.event, 'plan_expired');

        await setEnd('-3 days');
        await remind();
        await setEnd('20 days');
        await remind();
        assert.equal(mine().length, 3, 'nothing for a plan that ended long ago or ends far away');
    });
});
