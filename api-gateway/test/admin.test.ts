import './setup-env';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { MongoClient } from 'mongodb';
import { env } from '../src/config/env';
import accountRoutes from '../src/modules/account/routes';
import adminRoutes from '../src/modules/admin/routes';
import { adminKeyMatches, cameThroughTunnel } from '../src/modules/admin/guard';
import { daySeries, vietnamDays } from '../src/modules/admin/overview';
import { expandPermissions, staffCan } from '../src/modules/admin/permissions';
import { createRootStaff, temporaryPassword } from '../src/modules/admin/staff';
import { readHistory } from '../src/modules/assistant/memory';
import automationRoutes from '../src/modules/automations/routes';
import { runDueAutomations } from '../src/modules/automations/firing';
import { accountPushFrom } from '../src/modules/push/service';
import paymentRoutes from '../src/modules/payments/routes';
import sceneRoutes from '../src/modules/scenes/routes';
import { runDueSchedules } from '../src/modules/scenes/schedules';
import { REDIS_CHANNELS } from '../../shared/constants';
import { createTestDatabase, skipWithoutMongo, TEST_MONGO_URL, TestDatabase } from './helpers/testDatabase';
import { buildTestApp, recordPublishes, signIn, signUp, SignedInUser } from './helpers/testApp';
import { createOwnedDevice } from './helpers/fixtures';

const KEY = 'test-admin-key-0123456789-abcdefghijklmnop';
const ZONE = 'Asia/Ho_Chi_Minh';

test('only the configured key, never through the tunnel', () => {
    assert.equal(adminKeyMatches(KEY, KEY), true);
    assert.equal(adminKeyMatches(`${KEY}x`, KEY), false);
    assert.equal(adminKeyMatches(undefined, KEY), false);
    assert.equal(adminKeyMatches('', ''), false, 'no key configured accepts nothing');
    assert.equal(cameThroughTunnel({ 'cf-ray': '8f0c1-HKG' }), true);
    assert.equal(cameThroughTunnel({ 'cf-connecting-ip': '1.2.3.4' }), true);
    assert.equal(cameThroughTunnel({ host: 'api-gateway:3000' }), false);
});

test('a manage permission includes its view; only the root manages staff', () => {
    assert.deepEqual(expandPermissions(['accounts.manage', 'simulator.manage', 'nonsense']),
        ['accounts.view', 'accounts.manage', 'simulator.view', 'simulator.manage']);
    assert.deepEqual(expandPermissions(['plans.gift']), ['accounts.view', 'plans.gift']);
    const accountant = { is_root: false, permissions: expandPermissions(['payments.manage']) };
    assert.equal(staffCan(accountant, 'payments.view'), true);
    assert.equal(staffCan(accountant, 'simulator.view'), false);
    assert.equal(staffCan(accountant, 'staff.manage'), false);
    assert.equal(staffCan({ is_root: true, permissions: [] }, 'staff.manage'), true);
    assert.match(temporaryPassword(), /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
});

test('chart days are Vietnam calendar days', () => {
    // 23:30 on 22/11 in Hà Nội is 16:30 UTC.
    const { days, todayStart, start } = vietnamDays(new Date('2026-11-22T16:30:00Z'), 3);
    assert.deepEqual(days, ['2026-11-20', '2026-11-21', '2026-11-22']);
    assert.equal(todayStart.toISOString(), '2026-11-21T17:00:00.000Z');
    assert.equal(start.toISOString(), '2026-11-19T17:00:00.000Z');
    assert.equal(vietnamDays(new Date('2026-11-22T17:30:00Z'), 1).days[0], '2026-11-23');
    assert.deepEqual(daySeries(days, [{ day: '2026-11-21', value: '7' }]), [0, 7, 0]);
});

test('a gifted plan reaches the phone', () => {
    const push = accountPushFrom({
        account_id: 'a1', event: 'plan_gifted',
        data: { plan: { code: 'basic', name: 'Cơ bản' }, days: 30, expires_at: '2026-12-23T10:00:00.000Z' },
    });
    assert.equal(push?.message.title, 'Bạn được tặng gói trợ lý');
    assert.equal(push?.message.body, 'Gói Cơ bản đã được kích hoạt đến 23/12/2026.');
});

test.describe('administration API', { skip: skipWithoutMongo }, () => {
    let db: TestDatabase;
    let app: FastifyInstance;
    let mongo: MongoClient;

    const ROOT_EMAIL = 'root@xuanlam.vn';
    const ROOT_PASSWORD = 'mat-khau-goc-2026';
    let rootSession = '';

    const login = (email: string, password: string) =>
        app.inject({ method: 'POST', url: '/admin/staff/login', headers: { 'x-admin-key': KEY }, payload: { email, password } });

    /** Signs in with a temporary password and replaces it, as the Console makes everyone do. */
    async function signInStaff(email: string, temporary: string, password: string) {
        const first = await login(email, temporary);
        assert.equal(first.statusCode, 200, first.body);
        assert.equal(first.json().staff.must_change_password, true);
        const session = first.json().session_token as string;
        const changed = await app.inject({
            method: 'POST', url: '/admin/staff/me/password',
            headers: { 'x-admin-key': KEY, 'x-staff-session': session },
            payload: { current_password: temporary, new_password: password },
        });
        assert.equal(changed.statusCode, 200, changed.body);
        return session;
    }

    test.before(async () => {
        Object.assign(env, { ADMIN_API_KEY: KEY, PAYMENT_MODE: 'mock' });
        db = await createTestDatabase();
        mongo = await new MongoClient(TEST_MONGO_URL).connect();
        app = await buildTestApp(
            db.pool,
            [accountRoutes, adminRoutes, sceneRoutes, automationRoutes, paymentRoutes],
            { client: mongo, db: mongo.db(`admin_${Date.now()}`) },
        );
        const root = await createRootStaff(db.pool, { email: ROOT_EMAIL, full_name: 'Xuân Lâm' });
        rootSession = await signInStaff(ROOT_EMAIL, root.temporary_password, ROOT_PASSWORD);
    });
    test.after(async () => {
        await app?.mongo.db.dropDatabase().catch(() => undefined);
        await app?.close();
        await mongo?.close();
        await db?.drop();
    });

    /** A call from the Console for the signed-in root (or another staff session). */
    const admin = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object, headers: Record<string, string> = {}) =>
        app.inject({
            method, url,
            headers: { 'x-admin-key': KEY, 'x-staff-session': rootSession, ...headers },
            ...(payload ? { payload } : {}),
        });
    const as = (session: string) => (method: 'GET' | 'POST', url: string, payload?: object) =>
        admin(method, url, payload, { 'x-staff-session': session });
    const call = (user: SignedInUser, method: 'GET' | 'POST', url: string, payload?: object) =>
        app.inject({ method, url, headers: user.headers, ...(payload ? { payload } : {}) });
    const reason = 'Khách báo bị lộ mật khẩu';

    test('refuses requests without the key, through the tunnel, or when administration is off', async () => {
        assert.equal((await app.inject({ method: 'GET', url: '/admin/overview' })).statusCode, 401);
        const wrong = await app.inject({ method: 'GET', url: '/admin/overview', headers: { 'x-admin-key': 'x'.repeat(40) } });
        assert.equal(wrong.json().error.code, 'ADMIN_KEY_INVALID');
        const tunnel = await admin('GET', '/admin/overview', undefined, { 'cf-ray': '8f0c1-HKG' });
        assert.equal(tunnel.statusCode, 403);
        assert.equal(tunnel.json().error.code, 'ADMIN_INTERNAL_ONLY');
        // Checked before the input: a bad body without the key is still 401.
        assert.equal((await app.inject({ method: 'POST', url: '/admin/accounts/x/disable', payload: {} })).statusCode, 401);
        // A customer's own token is not an administration key, nor a staff session.
        const customer = await signUp(app);
        assert.equal((await call(customer, 'GET', '/admin/overview')).statusCode, 401);
        const noSession = await app.inject({ method: 'GET', url: '/admin/overview', headers: { 'x-admin-key': KEY } });
        assert.equal(noSession.json().error.code, 'STAFF_SESSION_INVALID');
        const customerAsStaff = await admin('GET', '/admin/overview', undefined, { 'x-staff-session': customer.accessToken });
        assert.equal(customerAsStaff.statusCode, 401);

        env.ADMIN_API_KEY = '';
        try {
            assert.equal((await admin('GET', '/admin/overview')).statusCode, 404);
        } finally {
            env.ADMIN_API_KEY = KEY;
        }
    });

    test('overview, search by email, name and device MAC, filters', async () => {
        const owner = await signUp(app, { fullName: 'Nguyễn Văn Tìm' });
        const device = await createOwnedDevice(db.pool, owner.id, { productId: 'prod_hazard_mitigation' });

        const overview = (await admin('GET', '/admin/overview')).json();
        assert.equal(overview.success, true);
        assert.ok(overview.accounts.total >= 1);
        assert.ok(overview.devices.by_product.some((item: any) => item.product_id === 'prod_hazard_mitigation'));
        assert.equal(overview.daily.days.length, 30);
        assert.equal(overview.plans[0].code, 'free');

        const byName = (await admin('GET', `/admin/accounts?q=${encodeURIComponent('văn tìm')}`)).json();
        assert.deepEqual(byName.items.map((item: any) => item.id), [owner.id]);
        const byMac = (await admin('GET', `/admin/accounts?q=${encodeURIComponent(device.mac.toLowerCase())}`)).json();
        assert.deepEqual(byMac.items.map((item: any) => item.id), [owner.id]);
        assert.equal(byMac.items[0].owned_devices, 1);
        assert.equal(byMac.items[0].plan.code, 'free');
        const percent = (await admin('GET', `/admin/accounts?q=${encodeURIComponent('%')}`)).json();
        assert.equal(percent.total, 0, 'a percent sign is a literal');

        const detail = (await admin('GET', `/admin/accounts/${owner.id}`)).json();
        assert.equal(detail.account.email, owner.email);
        assert.deepEqual(detail.devices.map((item: any) => [item.mac, item.role]), [[device.mac, 'owner']]);
        assert.equal(detail.sessions.length, 1);
        assert.equal(detail.plan.code, 'free');
        assert.equal((await admin('GET', '/admin/accounts/00000000-0000-4000-8000-000000000000')).statusCode, 404);
    });

    test('locking ends every session, pauses smart features and tells a returning user', async () => {
        const owner = await signUp(app);
        const roof = await createOwnedDevice(db.pool, owner.id, { productId: 'prod_roof_controller', catalogRevision: 2 });
        const scene = (await call(owner, 'POST', '/scenes', {
            name: 'Đóng mái', steps: [{ mac: roof.mac, instance_id: 'roof_motor', operation: 'close' }],
        })).json().scene;
        const schedule = (await call(owner, 'POST', `/scenes/${scene.id}/schedules`, {
            time: '19:00', days: [1, 2, 3, 4, 5, 6, 7], timezone: ZONE,
        })).json().schedule;
        const reminder = (await call(owner, 'POST', '/automations', {
            name: 'Nhắc tối', timezone: ZONE, notify_message: 'Nhớ đóng cửa',
            trigger: { kind: 'time', time: '21:00', days: [1, 2, 3, 4, 5, 6, 7] }, conditions: [],
        })).json().automation;
        assert.ok(schedule?.id && reminder?.id);

        assert.equal((await admin('POST', `/admin/accounts/${owner.id}/disable`, {})).statusCode, 400, 'a reason is required');
        const published = recordPublishes(app);
        const locked = await admin('POST', `/admin/accounts/${owner.id}/disable`, { reason });
        assert.equal(locked.statusCode, 200, locked.body);
        assert.deepEqual(locked.json().signed_out_sessions, 1);
        assert.ok(published.some(item => item.channel === REDIS_CHANNELS.ACCOUNT_SESSIONS_REVOKED
            && item.payload.account_id === owner.id && item.payload.all === true));
        assert.equal((await call(owner, 'GET', '/me')).statusCode, 401, 'the open app is signed out');
        assert.equal((await admin('POST', `/admin/accounts/${owner.id}/disable`, { reason })).statusCode, 409);

        const relogin = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: owner.email, password: owner.password } });
        assert.equal(relogin.statusCode, 403);
        assert.equal(relogin.json().error.code, 'ACCOUNT_LOCKED');
        const guess = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: owner.email, password: 'wrong password!' } });
        assert.equal(guess.json().error.code, 'INVALID_CREDENTIALS', 'a wrong password learns nothing');

        // While locked, the schedule and the automation pass without acting.
        await db.pool.query(`UPDATE scene_schedules SET next_run_at = NOW() - interval '1 minute' WHERE id = $1`, [schedule.id]);
        await db.pool.query(`UPDATE automations SET next_run_at = NOW() - interval '1 minute' WHERE id = $1`, [reminder.id]);
        assert.equal(await runDueSchedules(app), 1);
        assert.equal(await runDueAutomations(app), 1);
        const scheduleRow = (await db.pool.query('SELECT * FROM scene_schedules WHERE id = $1', [schedule.id])).rows[0];
        assert.equal(scheduleRow.last_result, null);
        assert.ok(scheduleRow.next_run_at > new Date(), 'the schedule moved to its next occurrence');
        assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM scene_runs WHERE scene_id = $1', [scene.id])).rows[0].n, 0);
        const automationRow = (await db.pool.query('SELECT * FROM automations WHERE id = $1', [reminder.id])).rows[0];
        assert.equal(automationRow.last_result, null);
        assert.ok(automationRow.next_run_at > new Date());
        assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM account_notifications WHERE account_id = $1', [owner.id])).rows[0].n, 0);

        const listed = (await admin('GET', '/admin/accounts?filter=disabled')).json();
        assert.ok(listed.items.some((item: any) => item.id === owner.id && item.status === 'disabled'));

        const unlocked = await admin('POST', `/admin/accounts/${owner.id}/enable`, { reason: 'Đã xác minh chủ tài khoản' });
        assert.equal(unlocked.statusCode, 200, unlocked.body);
        const back = await signIn(app, owner.email, owner.password);
        assert.equal((await call(back, 'GET', '/me')).statusCode, 200);
        await db.pool.query(`UPDATE automations SET next_run_at = NOW() - interval '1 minute' WHERE id = $1`, [reminder.id]);
        await runDueAutomations(app);
        assert.equal((await db.pool.query('SELECT last_result FROM automations WHERE id = $1', [reminder.id])).rows[0].last_result, 'notified');

        const signedOut = (await admin('POST', `/admin/accounts/${owner.id}/sign-out`, { reason })).json();
        assert.equal(signedOut.signed_out_sessions, 1);
        assert.equal((await call(back, 'GET', '/me')).statusCode, 401);

        const log = (await admin('GET', `/admin/audit?account_id=${owner.id}`)).json();
        assert.deepEqual(log.items.map((item: any) => item.action), ['account.signed_out', 'account.enabled', 'account.disabled']);
        assert.equal(log.items[2].reason, reason);
        assert.deepEqual(log.items[2].actor, { kind: 'staff', id: log.items[2].actor.id, email: ROOT_EMAIL, name: 'Xuân Lâm' });
        assert.equal(log.items[2].account.email, owner.email);
    });

    test('gifting a plan extends it like a purchase and tells the customer', async () => {
        const customer = await signUp(app);
        assert.equal((await admin('POST', `/admin/accounts/${customer.id}/gift-plan`, { plan_code: 'free', days: 7, reason })).statusCode, 400);
        const published = recordPublishes(app);
        const first = await admin('POST', `/admin/accounts/${customer.id}/gift-plan`, { plan_code: 'basic', days: 30, reason: 'Bù lỗi trợ lý' });
        assert.equal(first.statusCode, 200, first.body);
        const end = new Date(first.json().gift.expires_at).getTime();
        assert.ok(Math.abs(end - (Date.now() + 30 * 86400_000)) < 60_000);
        const second = (await admin('POST', `/admin/accounts/${customer.id}/gift-plan`, { plan_code: 'basic', days: 10, reason: 'Khuyến mãi' })).json();
        assert.equal(new Date(second.gift.expires_at).getTime(), end + 10 * 86400_000, 'the same plan continues from its end');
        assert.ok(published.some(item => item.channel === REDIS_CHANNELS.ACCOUNT_EVENT && item.payload.event === 'plan_gifted'
            && item.payload.account_id === customer.id && item.payload.data.plan.code === 'basic'));
        const history = await readHistory(app, customer.id);
        assert.match(history.at(-1)?.text ?? '', /tặng 10 ngày gói Cơ bản/);
        const plan = (await admin('GET', `/admin/accounts/${customer.id}`)).json().plan;
        assert.equal(plan.code, 'basic');
        const paid = (await admin('GET', '/admin/accounts?filter=paid')).json();
        assert.ok(paid.items.some((item: any) => item.id === customer.id));
        const plans = (await admin('GET', '/admin/plans')).json().plans;
        assert.deepEqual(plans.map((item: any) => item.code), ['basic', 'pro']);
    });

    test('confirms and cancels orders with a reason, like the CLI', async () => {
        const buyer = await signUp(app);
        const first = (await call(buyer, 'POST', '/payments/orders', { plan_code: 'basic', months: 1 })).json().order;
        const part = await admin('POST', `/admin/payments/${first.code}/confirm`, { amount_vnd: 20000, reason: 'Thấy trong app ngân hàng' });
        assert.equal(part.statusCode, 200, part.body);
        assert.equal(part.json().order.status, 'review');
        const review = (await admin('GET', '/admin/payments?tab=review')).json();
        assert.ok(review.items.some((item: any) => item.code === first.code && item.account.email === buyer.email));
        assert.ok(review.counts.review >= 1);
        const rest = (await admin('POST', `/admin/payments/${first.code.toLowerCase()}/confirm`, { reason: 'Khách chuyển nốt' })).json();
        assert.equal(rest.order.status, 'paid');
        assert.equal(rest.order.received_vnd, rest.order.amount_vnd);
        const paidTab = (await admin('GET', '/admin/payments?tab=paid')).json();
        assert.ok(paidTab.items.some((item: any) => item.code === first.code && item.paid_via === 'manual'));

        const second = (await call(buyer, 'POST', '/payments/orders', { plan_code: 'pro', months: 1 })).json().order;
        assert.equal((await admin('POST', `/admin/payments/${second.code}/cancel`, { reason: 'Khách đặt nhầm' })).json().order.status, 'cancelled');
        assert.equal((await admin('POST', `/admin/payments/${second.code}/cancel`, { reason: 'Khách đặt nhầm' })).statusCode, 409);

        const log = (await admin('GET', `/admin/audit?account_id=${buyer.id}`)).json();
        assert.deepEqual(log.items.map((item: any) => [item.action, item.details.code]), [
            ['payment.cancelled', second.code],
            ['payment.confirmed', first.code],
            ['payment.confirmed', first.code],
        ]);
        assert.equal(log.items[2].details.amount_vnd, 20000);
        assert.equal(log.items[1].details.amount_vnd, first.amount_vnd - 20000);
    });

    test('the root signs in, must replace the temporary password, and is locked out after five wrong ones', async () => {
        assert.equal((await createRootStaff(db.pool, { email: 'second@xuanlam.vn', full_name: 'Hai' }).catch(error => error)).code,
            'STAFF_ROOT_EXISTS', 'exactly one root');
        const wrong = await login(ROOT_EMAIL, 'not the password');
        assert.equal(wrong.json().error.code, 'STAFF_INVALID_CREDENTIALS');
        const unknown = await login('nobody@xuanlam.vn', 'whatever');
        assert.equal(unknown.json().error.code, 'STAFF_INVALID_CREDENTIALS', 'an unknown e-mail looks the same');

        // A new staff member: only "change your password" until they do.
        const created = (await admin('POST', '/admin/staff', {
            email: 'Lan@XuanLam.vn', full_name: 'Nguyễn Thị Lan', permissions: ['accounts.manage'],
        })).json();
        assert.deepEqual(created.staff.permissions, ['accounts.view', 'accounts.manage']);
        const first = (await login('lan@xuanlam.vn', created.temporary_password)).json();
        const lan = as(first.session_token);
        assert.equal((await lan('GET', '/admin/accounts')).json().error.code, 'STAFF_PASSWORD_CHANGE_REQUIRED');
        assert.equal((await lan('GET', '/admin/staff/me')).json().staff.must_change_password, true);
        const weak = await lan('POST', '/admin/staff/me/password', { current_password: created.temporary_password, new_password: 'short' });
        assert.equal(weak.json().error.code, 'STAFF_PASSWORD_WEAK');
        assert.equal((await lan('POST', '/admin/staff/me/password', {
            current_password: created.temporary_password, new_password: 'mat-khau-cua-lan',
        })).statusCode, 200);
        assert.equal((await lan('GET', '/admin/accounts')).statusCode, 200);

        for (let attempt = 1; attempt <= 4; attempt += 1) {
            assert.equal((await login('lan@xuanlam.vn', `wrong-${attempt}`)).statusCode, 401);
        }
        const fifth = await login('lan@xuanlam.vn', 'wrong-5');
        assert.equal(fifth.statusCode, 429);
        assert.equal((await login('lan@xuanlam.vn', 'mat-khau-cua-lan')).json().error.code, 'STAFF_LOCKED', 'even the right password waits');
        const sessions = (await lan('GET', '/admin/staff/me/sessions')).json().sessions;
        assert.ok(sessions.some((item: any) => item.current), 'a session already open keeps working');
    });

    test('each staff member sees and does only what the root ticked', async () => {
        const make = async (email: string, permissions: string[]) => {
            const created = (await admin('POST', '/admin/staff', { email, full_name: email, permissions })).json();
            return as(await signInStaff(email, created.temporary_password, 'mat-khau-nhan-vien'));
        };
        const support = await make('support@xuanlam.vn', ['accounts.manage', 'audit.view']);
        const accountant = await make('accountant@xuanlam.vn', ['overview.view', 'payments.manage', 'plans.gift']);
        const engineer = await make('engineer@xuanlam.vn', ['overview.view', 'simulator.manage']);
        const customer = await signUp(app);

        assert.equal((await support('GET', '/admin/accounts')).statusCode, 200);
        assert.equal((await support('GET', '/admin/payments')).json().error.code, 'STAFF_FORBIDDEN');
        assert.equal((await support('GET', '/admin/overview')).statusCode, 403);
        assert.equal((await support('GET', '/admin/staff')).statusCode, 403, 'only the root manages staff');
        assert.ok(Array.isArray((await support('GET', `/admin/accounts/${customer.id}`)).json().admin_log));
        assert.equal((await support('POST', `/admin/accounts/${customer.id}/sign-out`, { reason: 'Khách nhờ đăng xuất' })).statusCode, 200);
        assert.equal((await support('POST', `/admin/accounts/${customer.id}/gift-plan`, { plan_code: 'basic', days: 7, reason: 'Thử' })).statusCode, 403);

        assert.equal((await accountant('GET', '/admin/payments')).statusCode, 200);
        assert.equal((await accountant('POST', `/admin/accounts/${customer.id}/disable`, { reason: 'Không được phép' })).statusCode, 403);
        assert.equal((await accountant('GET', `/admin/accounts/${customer.id}`)).json().admin_log, null, 'no audit.view, no history');
        const gift = await accountant('POST', `/admin/accounts/${customer.id}/gift-plan`, { plan_code: 'basic', days: 7, reason: 'Bù lỗi thanh toán' });
        assert.equal(gift.statusCode, 200, gift.body);

        assert.equal((await engineer('GET', '/admin/accounts')).statusCode, 403);
        assert.equal((await engineer('POST', '/admin/audit/simulator', { method: 'POST', path: '/simulation-runs', status: 202 })).statusCode, 200);
        assert.equal((await support('POST', '/admin/audit/simulator', { method: 'POST', path: '/simulation-runs', status: 202 })).statusCode, 403);

        const byGift = (await admin('GET', `/admin/audit?action=plan.gifted&account_id=${customer.id}`)).json().items[0];
        assert.equal(byGift.actor.email, 'accountant@xuanlam.vn');
        const simulator = (await admin('GET', '/admin/audit?action=simulator.request')).json().items[0];
        assert.deepEqual([simulator.actor.email, simulator.details.path], ['engineer@xuanlam.vn', '/simulation-runs']);
    });

    test('the root locks, unlocks, resets and re-scopes staff; nobody touches the root', async () => {
        const created = (await admin('POST', '/admin/staff', {
            email: 'minh@xuanlam.vn', full_name: 'Minh', permissions: ['overview.view'],
        })).json();
        assert.equal((await admin('POST', '/admin/staff', { email: 'minh@xuanlam.vn', full_name: 'Minh', permissions: [] })).statusCode, 409);
        const minh = as(await signInStaff('minh@xuanlam.vn', created.temporary_password, 'mat-khau-cua-minh'));
        const id = created.staff.id as string;

        const widened = (await admin('PATCH', `/admin/staff/${id}`, { permissions: ['payments.manage'] })).json();
        assert.deepEqual(widened.staff.permissions, ['payments.view', 'payments.manage']);
        assert.equal((await minh('GET', '/admin/payments')).statusCode, 200, 'new permissions apply at once');
        assert.equal((await minh('GET', '/admin/overview')).statusCode, 403);

        assert.equal((await admin('POST', `/admin/staff/${id}/disable`, { reason: 'Nghỉ việc' })).json().signed_out_sessions, 1);
        assert.equal((await minh('GET', '/admin/payments')).json().error.code, 'STAFF_SESSION_INVALID');
        assert.equal((await login('minh@xuanlam.vn', 'mat-khau-cua-minh')).json().error.code, 'STAFF_DISABLED');
        assert.equal((await admin('POST', `/admin/staff/${id}/enable`, { reason: 'Quay lại làm' })).statusCode, 200);
        const reset = (await admin('POST', `/admin/staff/${id}/reset-password`, { reason: 'Quên mật khẩu' })).json();
        assert.equal((await login('minh@xuanlam.vn', 'mat-khau-cua-minh')).statusCode, 401, 'the old password stops working');
        assert.equal((await login('minh@xuanlam.vn', reset.temporary_password)).json().staff.must_change_password, true);

        const list = (await admin('GET', '/admin/staff')).json().staff;
        const root = list.find((item: any) => item.is_root);
        assert.equal(root.email, ROOT_EMAIL);
        assert.equal((await admin('POST', `/admin/staff/${root.id}/disable`, { reason: 'Thử khóa admin gốc' })).statusCode, 409);
        assert.equal((await admin('PATCH', `/admin/staff/${root.id}`, { permissions: [] })).statusCode, 409);
        const log = (await admin('GET', '/admin/audit?action=staff.disabled')).json().items;
        assert.equal(log[0].details.staff.email, 'minh@xuanlam.vn');
        assert.equal(log[0].reason, 'Nghỉ việc');
    });

    test('assistant usage without reading any message', async () => {
        const user = await signUp(app);
        const period = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit' }).format(new Date());
        await db.pool.query(
            `INSERT INTO assistant_usage (account_id, period, tokens, requests) VALUES ($1, $2, 900000, 12)`,
            [user.id, `${period}-01`],
        );
        await db.pool.query(
            `INSERT INTO assistant_turns (account_id, channel, message, reply, outcome, tokens) VALUES ($1, 'text', 'secret', 'reply', 'error', 50)`,
            [user.id],
        );
        const stats = await admin('GET', '/admin/assistant');
        assert.equal(stats.statusCode, 200, stats.body);
        const body = stats.json();
        assert.equal(body.top[0].account_id, user.id);
        assert.equal(body.top[0].tokens, 900000);
        assert.equal(body.daily.outcomes.error.at(-1), 1);
        assert.ok(!stats.body.includes('secret'), 'messages are never returned');
    });
});
