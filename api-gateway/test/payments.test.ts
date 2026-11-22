import './setup-env';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { env } from '../src/config/env';
import { readHistory } from '../src/modules/assistant/memory';
import assistantRoutes from '../src/modules/assistant/routes';
import paymentRoutes from '../src/modules/payments/routes';
import { confirmOrderManually } from '../src/modules/payments/service';
import { REDIS_CHANNELS } from '../../shared/constants';
import { createTestDatabase, skipWithoutDatabase, TestDatabase } from './helpers/testDatabase';
import { buildTestApp, recordPublishes, signUp, SignedInUser } from './helpers/testApp';

let db: TestDatabase;
let app: FastifyInstance;

const SECRET = 'sepay-test-secret';

const order = (user: SignedInUser, plan = 'basic', months = 1) =>
    app.inject({ method: 'POST', url: '/payments/orders', headers: user.headers, payload: { plan_code: plan, months } });

function sepay(payload: object, options: { secret?: string; timestamp?: number } = {}) {
    const body = JSON.stringify(payload);
    const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
    const signature = `sha256=${crypto.createHmac('sha256', options.secret ?? SECRET).update(`${timestamp}.${body}`).digest('hex')}`;
    return app.inject({
        method: 'POST', url: '/payments/sepay/webhook', payload: body,
        headers: { 'content-type': 'application/json', 'x-sepay-signature': signature, 'x-sepay-timestamp': timestamp },
    });
}

let transaction = 1000;
const transfer = (amount: number, content: string, extra: object = {}) => ({
    id: ++transaction, gateway: 'MBBank', transactionDate: '2026-11-22 11:20:05', accountNumber: '0123456789',
    code: null, content, transferType: 'in', transferAmount: amount, accumulated: 0, subAccount: null,
    referenceCode: `FT${transaction}`, description: '', ...extra,
});

async function planOf(accountId: string) {
    return (await db.pool.query('SELECT plan_code, expires_at FROM account_plans WHERE account_id = $1', [accountId])).rows[0];
}

const days = (from: Date, to: Date) => (new Date(to).getTime() - from.getTime()) / 86400_000;

test.describe('payments', { skip: skipWithoutDatabase }, () => {
    test.before(async () => {
        db = await createTestDatabase();
        app = await buildTestApp(db.pool, [paymentRoutes, assistantRoutes]);
    });
    test.after(async () => {
        await app?.close();
        await db?.drop();
    });
    test.beforeEach(() => {
        Object.assign(env, {
            PAYMENT_MODE: 'bank', PAYMENT_BANK_BIN: '970422', PAYMENT_BANK_ACCOUNT: '0123456789',
            PAYMENT_ACCOUNT_NAME: 'NGUYEN XUAN LAM', PAYMENT_BANK_NAME: 'MBBank', SEPAY_WEBHOOK_SECRET: SECRET, SEPAY_API_KEY: '',
        });
    });

    test('an order is priced by the server and carries a VietQR for the exact amount', async () => {
        const user = await signUp(app);
        const options = (await app.inject({ method: 'GET', url: '/payments/options', headers: user.headers })).json();
        assert.equal(options.mode, 'bank');
        assert.deepEqual(options.plans.map((plan: any) => [plan.code, plan.prices.map((price: any) => price.amount_vnd)]),
            [['basic', [49000, 490000]], ['pro', [99000, 990000]]]);

        const created = await order(user, 'pro', 12);
        assert.equal(created.statusCode, 200, created.body);
        const view = created.json().order;
        assert.match(view.code, /^SH[A-HJ-NP-Z2-9]{8}$/);
        assert.equal(view.amount_vnd, 990000);
        assert.equal(view.status, 'pending');
        assert.equal(view.transfer.amount_vnd, 990000);
        assert.equal(view.transfer.note, view.code);
        assert.match(view.transfer.qr, new RegExp(`^000201010212.*5406990000.*0810${view.code}6304[0-9A-F]{4}$`));

        assert.equal((await order(user, 'free')).json().error.code, 'PAYMENT_PLAN_INVALID');
        const forged = await app.inject({
            method: 'POST', url: '/payments/orders', headers: user.headers, payload: { plan_code: 'basic', months: 1, amount_vnd: 1 },
        });
        assert.equal(forged.json().order.amount_vnd, 49000, 'a client amount is ignored');

        const orders = (await app.inject({ method: 'GET', url: '/payments/orders', headers: user.headers })).json().orders;
        assert.deepEqual(orders.map((item: any) => item.status), ['pending'], 'a new order replaces the unpaid one');
    });

    test('a signed SePay transfer pays the order once and activates the plan', async () => {
        const user = await signUp(app);
        const published = recordPublishes(app);
        const code = (await order(user, 'basic', 1)).json().order.code;

        const forged = await sepay(transfer(49000, `NGUYEN VAN A ${code}`), { secret: 'wrong' });
        assert.equal(forged.statusCode, 401);
        const stale = await sepay(transfer(49000, code), { timestamp: Math.floor(Date.now() / 1000) - 600 });
        assert.equal(stale.statusCode, 401, 'replays older than 5 minutes are refused');
        assert.equal(await planOf(user.id), undefined);

        const payload = transfer(49000, `MBVCB.123.${code.toLowerCase()}.CT tu 0987`);
        const paid = await sepay(payload);
        assert.equal(paid.statusCode, 200, paid.body);
        assert.deepEqual(paid.json(), { success: true });
        const plan = await planOf(user.id);
        assert.equal(plan.plan_code, 'basic');
        assert.ok(days(new Date(), plan.expires_at) > 27 && days(new Date(), plan.expires_at) < 32);

        const status = (await app.inject({ method: 'GET', url: `/payments/orders/${code}`, headers: user.headers })).json().order;
        assert.equal(status.status, 'paid');
        assert.equal(status.paid_via, 'sepay');
        assert.equal(status.transfer, null);
        const usage = (await app.inject({ method: 'GET', url: '/assistant/usage', headers: user.headers })).json();
        assert.equal(usage.plan.code, 'basic');
        assert.equal(usage.plan.monthly_tokens, 1500000);
        const event = published.find(item => item.channel === REDIS_CHANNELS.ACCOUNT_EVENT && item.payload.event === 'payment_updated');
        assert.equal(event?.payload.data.order.status, 'paid');
        const remembered = (await readHistory(app, user.id)).at(-1);
        assert.equal(remembered?.role, 'model');
        assert.match(remembered?.text ?? '', new RegExp(`^Đã nhận 49\\.000đ cho đơn ${code}\\. Gói Cơ bản đã kích hoạt đến \\d{2}/\\d{2}/\\d{4}\\.$`),
            'the assistant knows about the payment in the next chat');

        // SePay retries the same notification: nothing changes.
        assert.equal((await sepay(payload)).statusCode, 200);
        assert.equal(new Date((await planOf(user.id)).expires_at).getTime(), new Date(plan.expires_at).getTime());
        const outcomes = (await db.pool.query(
            'SELECT outcome FROM payment_transactions WHERE content ILIKE $1', [`%${code}%`],
        )).rows.map(row => row.outcome);
        assert.deepEqual(outcomes, ['paid']);
    });

    test('part payments add up; late transfers count; strangers and other accounts are recorded only', async () => {
        const user = await signUp(app);
        const code = (await order(user, 'basic', 1)).json().order.code;
        await sepay(transfer(20000, code));
        const partial = (await app.inject({ method: 'GET', url: `/payments/orders/${code}`, headers: user.headers })).json().order;
        assert.equal(partial.status, 'review');
        assert.equal(partial.transfer.amount_vnd, 29000, 'the QR asks only for the rest');
        await db.pool.query(`UPDATE payment_orders SET expires_at = NOW() - interval '1 hour' WHERE code = $1`, [code]);
        await sepay(transfer(29000, `${code} phan con lai`));
        assert.equal((await planOf(user.id)).plan_code, 'basic');

        await sepay(transfer(49000, 'SHZZZZZZZZ khong co don nay'));
        await sepay(transfer(49000, code, { accountNumber: '999999' }));
        await sepay(transfer(49000, code, { transferType: 'out' }));
        await sepay(transfer(49000, code));
        const rows = (await db.pool.query(
            `SELECT outcome FROM payment_transactions WHERE provider_ref::int > $1 ORDER BY provider_ref::int`, [transaction - 4],
        )).rows.map(row => row.outcome);
        assert.deepEqual(rows, ['unmatched', 'other_account', 'outgoing', 'already_paid']);
    });

    test('renewing extends; switching plans converts the unused time', async () => {
        const user = await signUp(app);
        const pay = async (plan: string, months: number) => {
            const code = (await order(user, plan, months)).json().order.code;
            const amount = months === 12 ? (plan === 'basic' ? 490000 : 990000) : (plan === 'basic' ? 49000 : 99000);
            assert.equal((await sepay(transfer(amount, code))).statusCode, 200);
        };
        await pay('basic', 1);
        const first = new Date((await planOf(user.id)).expires_at);
        await pay('basic', 1);
        const renewed = new Date((await planOf(user.id)).expires_at);
        assert.ok(days(first, renewed) >= 28 && days(first, renewed) <= 31, 'the same plan continues from its end');

        const remaining = days(new Date(), renewed);
        await pay('pro', 1);
        const upgraded = await planOf(user.id);
        assert.equal(upgraded.plan_code, 'pro');
        const expected = 30 + remaining * 49000 / 99000;
        assert.ok(Math.abs(days(new Date(), upgraded.expires_at) - expected) < 2.5, `about ${expected.toFixed(1)} days`);
    });

    test('mock mode, manual confirmation, cancelling, API key and disabled webhook', async () => {
        const user = await signUp(app);
        env.PAYMENT_MODE = 'mock';
        const created = (await order(user, 'pro', 1)).json().order;
        assert.equal(created.mock, true);
        assert.equal(created.transfer, null, 'no real account in mock mode');
        const simulated = await app.inject({ method: 'POST', url: `/payments/orders/${created.code}/simulate`, headers: user.headers });
        assert.equal(simulated.json().order.status, 'paid', simulated.body);
        assert.equal((await planOf(user.id)).plan_code, 'pro');

        env.PAYMENT_MODE = 'bank';
        const blocked = await app.inject({ method: 'POST', url: `/payments/orders/${created.code}/simulate`, headers: user.headers });
        assert.equal(blocked.statusCode, 404, 'no simulation with real payments');

        const other = await signUp(app);
        const manual = (await order(other, 'basic', 12)).json().order.code;
        const confirmed = await confirmOrderManually({ pg: db.pool, redis: null, log: { info() {}, warn() {} } }, manual);
        assert.equal(confirmed.outcome, 'paid');
        assert.equal(confirmed.order?.paid_via, 'manual');
        assert.ok(days(new Date(), (await planOf(other.id)).expires_at) > 360);

        const cancel = (await order(other, 'pro', 1)).json().order.code;
        assert.equal((await app.inject({ method: 'POST', url: `/payments/orders/${cancel}/cancel`, headers: other.headers })).statusCode, 200);
        assert.equal((await app.inject({ method: 'POST', url: `/payments/orders/${cancel}/cancel`, headers: other.headers })).statusCode, 409);
        assert.equal((await app.inject({ method: 'GET', url: `/payments/orders/${cancel}`, headers: user.headers })).statusCode, 404,
            'orders are private');

        env.SEPAY_WEBHOOK_SECRET = '';
        env.SEPAY_API_KEY = 'sepay-api-key';
        const keyed = await app.inject({
            method: 'POST', url: '/payments/sepay/webhook', payload: transfer(10000, 'x'),
            headers: { authorization: 'Apikey sepay-api-key' },
        });
        assert.equal(keyed.statusCode, 200, keyed.body);
        const wrongKey = await app.inject({
            method: 'POST', url: '/payments/sepay/webhook', payload: transfer(10000, 'x'), headers: { authorization: 'Apikey nope' },
        });
        assert.equal(wrongKey.statusCode, 401);
        env.SEPAY_API_KEY = '';
        const disabled = await app.inject({ method: 'POST', url: '/payments/sepay/webhook', payload: transfer(10000, 'x') });
        assert.equal(disabled.statusCode, 503);

        env.PAYMENT_MODE = 'off';
        assert.equal((await order(user, 'basic', 1)).json().error.code, 'PAYMENT_UNAVAILABLE');
    });
});
