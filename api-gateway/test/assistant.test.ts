import './setup-env';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { MongoClient } from 'mongodb';
import { env } from '../src/config/env';
import assistantRoutes from '../src/modules/assistant/routes';
import { usagePeriod } from '../src/modules/assistant/quota';
import sceneRoutes from '../src/modules/scenes/routes';
import { createTestDatabase, skipWithoutMongo, TEST_MONGO_URL, TestDatabase } from './helpers/testDatabase';
import { buildTestApp, signUp, SignedInUser } from './helpers/testApp';
import { createOwnedDevice } from './helpers/fixtures';

let db: TestDatabase;
let app: FastifyInstance;
let mongo: MongoClient;
let servers: http.Server[] = [];

/** What the stand-in Gemini answers, from the user's words and the home data it was sent. */
let gemini: (said: string, home: any) => { status?: number; body: any };
let geminiCalls = 0;
let listen: () => { status?: number; body: any };

function serve(handler: (path: string, body: string) => { status?: number; body: any }): Promise<string> {
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const answer = handler(req.url ?? '', Buffer.concat(chunks).toString('utf8'));
            res.writeHead(answer.status ?? 200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(answer.body));
        });
    });
    servers.push(server);
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

const call = (user: SignedInUser, name: string, args: object) => ({
    candidates: [{ content: { parts: [{ functionCall: { name, args } }] }, finishReason: 'STOP' }],
    usageMetadata: { totalTokenCount: 1000 },
});
const say = (text: string) => ({
    candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata: { totalTokenCount: 400 },
});

function findAction(home: any, device: string, label: string): string {
    const found = home.devices.find((item: any) => item.name === device);
    return found.actions.find((action: any) => action.do.endsWith(label)).id;
}

const message = (user: SignedInUser, text: string, headers: object = {}) =>
    app.inject({ method: 'POST', url: '/assistant/message', headers: { ...user.headers, ...headers }, payload: { text } });

function voiceUpload(user: SignedInUser) {
    const boundary = '----assistant-test';
    const payload = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
        Buffer.alloc(3000, 1),
        Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return app.inject({
        method: 'POST', url: '/assistant/voice', payload,
        headers: { ...user.headers, 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
}

async function operations(deviceId: string) {
    return (await db.pool.query(
        'SELECT operation_name, input FROM device_operations WHERE device_id = $1 ORDER BY created_at', [deviceId],
    )).rows;
}

test.describe('assistant', { skip: skipWithoutMongo }, () => {
    test.before(async () => {
        db = await createTestDatabase();
        mongo = await new MongoClient(TEST_MONGO_URL).connect();
        app = await buildTestApp(db.pool, [sceneRoutes, assistantRoutes], { client: mongo, db: mongo.db(`assistant_${Date.now()}`) });
        env.GEMINI_API_KEY = 'test-key';
        env.GEMINI_API_URL = await serve((_, body) => {
            geminiCalls += 1;
            const request = JSON.parse(body);
            const parts = request.contents.at(-1).parts;
            const home = JSON.parse(parts[0].text.slice(parts[0].text.indexOf('\n') + 1));
            return gemini(parts[1].text.replace('Người dùng nói: ', ''), home);
        });
        env.VOICE_SERVICE_TOKEN = 'gateway-voice-token-123';
        env.VOICE_SERVICE_URL = await serve(() => listen());
    });
    test.after(async () => {
        await app?.mongo.db.dropDatabase().catch(() => undefined);
        await app?.close();
        await mongo?.close();
        await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
        await db?.drop();
    });

    test('a typed command runs through the device path; chat runs nothing', async () => {
        const user = await signUp(app);
        const awning = await createOwnedDevice(db.pool, user.id, { name: 'Mái che', productId: 'prod_roof_controller', catalogRevision: 2 });
        gemini = (said, home) => ({ body: call(user, 'control_device', { action_id: findAction(home, 'Mái che', 'Mở mái'), quote: said }) });
        const opened = await message(user, 'mở mái che');
        assert.equal(opened.statusCode, 200, opened.body);
        const body = opened.json();
        assert.equal(body.outcome, 'action');
        assert.equal(body.reply, 'Đã gửi lệnh "Mở mái" (Mái che).');
        assert.deepEqual(body.actions, [{ kind: 'device', label: 'Mở mái', target: 'Mái che', status: 'sent' }]);
        assert.deepEqual(body.usage, { used_tokens: 1000, monthly_tokens: 100000, plan: 'free' });
        assert.deepEqual((await operations(awning.id)).map(row => row.operation_name), ['open']);

        gemini = () => ({ body: say('Mái che đang dừng, trời không mưa.') });
        const chat = await message(user, 'mái che đang thế nào?');
        assert.equal(chat.json().outcome, 'chat');
        assert.equal(chat.json().reply, 'Mái che đang dừng, trời không mưa.');
        assert.equal((await operations(awning.id)).length, 1);

        // A command the model invents ("mở mái che" was never said) is dropped.
        gemini = (_, home) => ({ body: call(user, 'control_device', { action_id: findAction(home, 'Mái che', 'Đóng mái'), quote: 'đóng mái che' }) });
        const invented = await message(user, 'kể chuyện cười đi');
        assert.equal(invented.json().outcome, 'clarify');
        assert.equal((await operations(awning.id)).length, 1);

        const turns = (await db.pool.query('SELECT outcome, tokens FROM assistant_turns WHERE account_id = $1 ORDER BY created_at', [user.id])).rows;
        assert.deepEqual(turns, [{ outcome: 'action', tokens: 1000 }, { outcome: 'chat', tokens: 400 }, { outcome: 'clarify', tokens: 1000 }]);
        const usage = await app.inject({ method: 'GET', url: '/assistant/usage', headers: user.headers });
        assert.equal(usage.json().used_tokens, 2400);
        assert.equal(usage.json().requests, 3);
        assert.deepEqual(usage.json().plans.map((plan: any) => plan.code), ['free', 'basic', 'pro']);
    });

    test('operations the app confirms wait for the user; protected scenes need the password', async () => {
        const user = await signUp(app);
        const door = await createOwnedDevice(db.pool, user.id, { name: 'Cửa chính', productId: 'prod_entrance_controller', catalogRevision: 6 });
        gemini = (said, home) => ({ body: call(user, 'control_device', { action_id: findAction(home, 'Cửa chính', 'Mở khóa'), quote: said }) });
        const asked = (await message(user, 'mở khóa cửa chính')).json();
        assert.equal(asked.outcome, 'confirm');
        assert.equal(asked.actions[0].status, 'pending');
        assert.equal(asked.actions[0].confirmation, 'confirm');
        assert.equal((await operations(door.id)).length, 0);
        const confirm = (pendingId: string, headers: object = {}) => app.inject({
            method: 'POST', url: '/assistant/confirm', headers: { ...user.headers, ...headers }, payload: { pending_id: pendingId },
        });
        const done = await confirm(asked.actions[0].pending_id);
        assert.equal(done.statusCode, 200, done.body);
        assert.equal(done.json().action.status, 'sent');
        assert.deepEqual((await operations(door.id)).map(row => row.operation_name), ['unlock']);
        assert.equal((await confirm(asked.actions[0].pending_id)).statusCode, 404, 'a confirmation runs once');

        const scene = await app.inject({
            method: 'POST', url: '/scenes', headers: user.headers,
            payload: { name: 'Ra khỏi nhà', steps: [{ mac: door.mac, instance_id: 'main_lock', operation: 'unlock' }] },
        });
        assert.equal(scene.statusCode, 200, scene.body);
        gemini = (said, home) => ({ body: call(user, 'run_scene', { scene_id: home.scenes[0].id, quote: said }) });
        const pending = (await message(user, 'chạy kịch bản ra khỏi nhà')).json();
        assert.equal(pending.actions[0].confirmation, 'reauthenticate');
        assert.equal((await confirm(pending.actions[0].pending_id)).json().error.code, 'REAUTHENTICATION_REQUIRED');
        const reauth = await app.inject({ method: 'POST', url: '/auth/reauthenticate', headers: user.headers, payload: { password: user.password } });
        const ran = await confirm(pending.actions[0].pending_id, { 'x-reauth-token': reauth.json().reauth_token });
        assert.equal(ran.json().action.status, 'sent', ran.body);
        assert.equal(ran.json().reply, 'Đã chạy kịch bản "Ra khỏi nhà".');
    });

    test('spoken commands need the owner\'s verified voice; spoken chat does not', async () => {
        const user = await signUp(app);
        const awning = await createOwnedDevice(db.pool, user.id, { name: 'Mái che', productId: 'prod_roof_controller', catalogRevision: 2 });
        gemini = (said, home) => said.includes('mái')
            ? { body: call(user, 'control_device', { action_id: findAction(home, 'Mái che', 'Đóng mái'), quote: said }) }
            : { body: say('Hôm nay là thứ Bảy.') };
        const heard = (verification: object | null, transcript = 'đóng mái che') =>
            () => ({ body: { transcript, speech_ms: 1500, snr_db: 30, verification } });

        listen = heard(null);
        const unenrolled = (await voiceUpload(user)).json();
        assert.equal(unenrolled.transcript, 'đóng mái che');
        assert.equal(unenrolled.outcome, 'refused');
        assert.match(unenrolled.reply, /đăng ký giọng nói/);

        listen = heard({ accepted: false, reason: 'not_matched' });
        const stranger = (await voiceUpload(user)).json();
        assert.equal(stranger.outcome, 'refused');
        assert.equal(stranger.voice_verified, false);
        assert.equal(await app.redis.get(`voice:fail:${user.id}`), '1');
        assert.equal((await operations(awning.id)).length, 0);

        listen = heard({ accepted: false, reason: 'not_matched' }, 'hôm nay thứ mấy');
        const chat = (await voiceUpload(user)).json();
        assert.equal(chat.outcome, 'chat');
        assert.equal(await app.redis.get(`voice:fail:${user.id}`), '1', 'chat never counts towards the lock');

        listen = heard({ accepted: true, reason: null });
        const owner = (await voiceUpload(user)).json();
        assert.equal(owner.outcome, 'action');
        assert.equal(await app.redis.get(`voice:fail:${user.id}`), null);
        assert.deepEqual((await operations(awning.id)).map(row => row.operation_name), ['close']);

        listen = () => ({ status: 422, body: { error: { code: 'VOICE_NOT_UNDERSTOOD', message: 'Không nghe rõ lời nói, hãy nói lại.', details: {} } } });
        const unclear = await voiceUpload(user);
        assert.equal(unclear.statusCode, 422);
        assert.equal(unclear.json().error.code, 'VOICE_NOT_UNDERSTOOD');
    });

    test('allowance per plan, the system ceiling and Gemini failures', async () => {
        const user = await signUp(app);
        gemini = () => ({ body: say('Xin chào!') });
        await db.pool.query('INSERT INTO assistant_usage (account_id, period, tokens) VALUES ($1, $2, 100000)', [user.id, usagePeriod().period]);
        const before = geminiCalls;
        const spent = await message(user, 'xin chào');
        assert.equal(spent.statusCode, 429);
        assert.equal(spent.json().error.code, 'ASSISTANT_QUOTA_EXCEEDED');
        assert.equal(spent.json().error.details.plan, 'free');
        assert.equal(geminiCalls, before, 'no tokens are spent once the allowance is used up');

        await db.pool.query(`INSERT INTO account_plans (account_id, plan_code, expires_at) VALUES ($1, 'basic', NOW() + interval '30 days')`, [user.id]);
        const upgraded = await message(user, 'xin chào');
        assert.equal(upgraded.statusCode, 200, upgraded.body);
        assert.equal(upgraded.json().usage.monthly_tokens, 1500000);

        gemini = () => ({ status: 429, body: { error: { message: 'quota' } } });
        assert.equal((await message(user, 'xin chào')).json().error.code, 'ASSISTANT_BUSY');
        const key = env.GEMINI_API_KEY;
        env.GEMINI_API_KEY = '';
        try {
            assert.equal((await message(user, 'xin chào')).json().error.code, 'ASSISTANT_UNAVAILABLE');
        } finally {
            env.GEMINI_API_KEY = key;
        }
        await app.redis.set(`assistant:tokens:${new Date().toISOString().slice(0, 10)}`, String(env.ASSISTANT_DAILY_TOKEN_CAP));
        assert.equal((await message(user, 'xin chào')).json().error.code, 'ASSISTANT_BUSY');
        await app.redis.del(`assistant:tokens:${new Date().toISOString().slice(0, 10)}`);
    });
});
