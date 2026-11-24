import './setup-env';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { MongoClient, ObjectId } from 'mongodb';
import { env } from '../src/config/env';
import { buildHomeContext } from '../src/modules/assistant/context';
import type { GeminiCall, GeminiRequest, GenerateFn } from '../src/modules/assistant/gemini';
import {
    answerIsGrounded,
    chartsOf,
    eventDetail,
    historyFallback,
    type HistoryFacts,
    resolveWindow,
} from '../src/modules/assistant/history';
import { planTurn } from '../src/modules/assistant/planner';
import assistantRoutes from '../src/modules/assistant/routes';
import { mayBeHistory } from '../src/modules/assistant/text';
import { FIXTURE_DEVICES, FIXTURE_SHADOWS, fixtureContext, historyId, loadCatalog } from './assistant/fixture';
import { createTestDatabase, skipWithoutMongo, TEST_MONGO_URL, TestDatabase } from './helpers/testDatabase';
import { buildTestApp, signUp, SignedInUser } from './helpers/testApp';
import { addMember, createOwnedDevice } from './helpers/fixtures';

// Monday 23/11/2026, 20:14 in Hà Nội.
const NOW = new Date('2026-11-23T13:14:00Z');
const window = (args: Record<string, unknown>) => resolveWindow(args, NOW);
const iso = (date: Date | undefined) => date?.toISOString();

test('periods are Vietnam days and hours, up to now and within 30 days', () => {
    const today = window({ period: 'today' })!;
    assert.deepEqual([iso(today.start), iso(today.end), today.label, today.days], ['2026-11-22T17:00:00.000Z', iso(NOW), 'hôm nay (23/11)', 1]);
    const yesterday = window({ period: 'yesterday' })!;
    assert.deepEqual([iso(yesterday.start), iso(yesterday.end), yesterday.label],
        ['2026-11-21T17:00:00.000Z', '2026-11-22T17:00:00.000Z', 'hôm qua (22/11)']);
    assert.equal(window({ period: 'last_hours', amount: 6 })!.label, '6 giờ qua');
    assert.equal(iso(window({ period: 'last_hours', amount: '6' })!.start), '2026-11-23T07:14:00.000Z');
    const days = window({ period: 'last_days', amount: 3 })!;
    assert.deepEqual([iso(days.start), days.label, days.days], ['2026-11-20T17:00:00.000Z', '3 ngày qua (21/11 – 23/11)', 3]);
    assert.equal(window({ period: 'this_week' })!.label, 'tuần này (từ thứ Hai 23/11)');
    const lastWeek = window({ period: 'last_week' })!;
    assert.deepEqual([iso(lastWeek.start), iso(lastWeek.end), lastWeek.label],
        ['2026-11-15T17:00:00.000Z', '2026-11-22T17:00:00.000Z', 'tuần trước (16/11 – 22/11)']);
    assert.deepEqual([iso(window({ period: 'this_month' })!.start), window({ period: 'this_month' })!.label],
        ['2026-10-31T17:00:00.000Z', 'tháng này (từ 01/11)']);
    assert.equal(window({ period: 'dates', from_date: '2026-11-20' })!.label, 'thứ Sáu 20/11');
    assert.equal(window({ period: 'dates', from_date: '2026-11-22' })!.label, 'hôm qua (22/11)');
    assert.equal(window({ period: 'dates', from_date: '2026-11-18', to_date: '2026-11-20' })!.label, '18/11 – 20/11');

    const evening = window({ period: 'yesterday', from_hour: 18 })!;
    assert.deepEqual([iso(evening.start), iso(evening.end), evening.label],
        ['2026-11-22T11:00:00.000Z', '2026-11-22T17:00:00.000Z', 'hôm qua (22/11), 18:00–24:00']);
    assert.equal(iso(window({ period: 'today', from_hour: 18 })!.end), iso(NOW), 'never past now');

    for (const bad of [
        { period: 'someday' }, { period: 'last_days', amount: 31 }, { period: 'last_hours', amount: 0 },
        { period: 'last_days', amount: 2.5 }, { period: 'dates', from_date: '2026-11-24' }, { period: 'dates', from_date: '2026-02-30' },
        { period: 'dates', from_date: '2026-11-20', to_date: '2026-11-19' }, { period: 'this_week', from_hour: 18 },
        { period: 'today', from_hour: 21 }, { period: 'yesterday', from_hour: 20, to_hour: 18 },
    ]) {
        assert.equal(window(bad), null, JSON.stringify(bad));
    }

    const october = window({ period: 'dates', from_date: '2026-10-01', to_date: '2026-11-01' })!;
    assert.equal(october.clipped, true);
    assert.equal(iso(october.start), '2026-10-24T13:14:00.000Z', 'only the last 30 days are kept');
    assert.equal(window({ period: 'dates', from_date: '2026-09-01' })!.too_old, true);
    assert.equal(window({ period: 'this_month' })!.clipped, false);
});

test('event data in words; unknown fields are left out', () => {
    assert.equal(eventDetail({ state: 'unlocked', source: 'keypad', reason: 'pin_ok' }), 'đã mở khóa, qua bàn phím');
    assert.equal(eventDetail({ cycle_id: 'c1', runtime_seconds: 600, reason: 'completed' }), 'chạy 10 phút, xong lượt');
    assert.equal(eventDetail({ attempts_remaining: 2 }), 'còn 2 lần thử');
    assert.equal(eventDetail({ incident_id: 'i1', cause: 'gas' }), 'do gas');
    assert.equal(eventDetail({ from: 'available', to: 'low' }), 'thành "sắp hết"');
    assert.equal(eventDetail({ angle_degrees: 87 }), null);
    assert.equal(eventDetail(null), null);
});

const doorFacts: HistoryFacts[] = [{
    kind: 'events', period: 'hôm qua (22/11)', device: 'Cửa chính', total: 5,
    by_event: [{ what: 'Cửa được mở', count: 3, first: '07:45 22/11', last: '22:14 22/11' },
        { what: 'Nhập sai mã PIN', count: 2, first: '10:02 22/11', last: '23:40 22/11' }],
    latest: [{ at: '23:40 22/11', what: 'Nhập sai mã PIN', detail: 'còn 2 lần thử' }],
}];

test('an answer may use only numbers from the facts or the question', () => {
    assert.ok(answerIsGrounded('Hôm qua (22/11) cửa chính được mở 3 lần, lần cuối lúc 22:14.', doorFacts, 'hôm qua cửa mở mấy lần'));
    assert.ok(answerIsGrounded('Mở lần đầu lúc 7:45.', doorFacts, 'x'), '07 and 7 are the same number');
    assert.ok(!answerIsGrounded('Hôm qua cửa được mở 4 lần.', doorFacts, 'x'), 'a count it computed itself');
    assert.ok(!answerIsGrounded('Lần cuối lúc 22:15.', doorFacts, 'x'));
    assert.ok(answerIsGrounded('Trong 3 ngày qua không có gì.', [{ kind: 'events', period: 'x', total: 0 }], '3 ngày qua cửa có mở không'));
    const reading: HistoryFacts[] = [{ kind: 'readings', period: 'hôm qua (22/11)', reading: 'Nhiệt độ', unit: '°C', samples: 3,
        highest: { value: 34.5, at: '14:05 22/11' }, lowest: { value: 28.5, at: '05:10 22/11' }, average: 31 }];
    assert.ok(answerIsGrounded('Cao nhất 34,5°C lúc 14:05, trung bình 31°C.', reading, 'x'));
    assert.ok(!answerIsGrounded('Cao nhất 35°C.', reading, 'x'), 'no rounding of its own');
});

test('the server\'s own sentence when the answer cannot be trusted', () => {
    assert.equal(historyFallback(doorFacts),
        'Hôm qua (22/11), Cửa chính: cửa được mở 3 lần (gần nhất 22:14 22/11); nhập sai mã pin 2 lần (gần nhất 23:40 22/11).');
    assert.equal(historyFallback([{ kind: 'events', period: 'hôm nay (23/11)', device: 'Cửa chính', sees: 'alerts_only', total: 0 }]),
        'Hôm nay (23/11), Cửa chính: không ghi nhận cảnh báo nào.');
    assert.equal(historyFallback([{ kind: 'readings', period: 'hôm qua (22/11)', device: 'Bếp', reading: 'Nhiệt độ', unit: '°C', samples: 3,
        highest: { value: 34.5, at: '14:05 22/11' }, lowest: { value: 28.5, at: '05:10 22/11' }, average: 31 }]),
    'Hôm qua (22/11), Bếp: nhiệt độ cao nhất 34.5°C lúc 14:05 22/11, thấp nhất 28.5°C lúc 05:10 22/11, trung bình 31°C.');
    assert.equal(historyFallback([{ kind: 'runs', period: 'tuần này (từ thứ Hai 23/11)', of: 'Đi ngủ', total: 0 }]),
        'Tuần này (từ thứ Hai 23/11), "Đi ngủ" không chạy lần nào.');
    assert.equal(historyFallback([{ kind: 'events', period: '01/09', too_old: true }]),
        'Hệ thống chỉ lưu lịch sử 30 ngày gần nhất nên không còn dữ liệu cho 01/09.');
    assert.equal(historyFallback([{ kind: 'commands', period: 'x', error: true }, { kind: 'runs', period: 'x', error: true }]),
        'Mình chưa tra được lịch sử lúc này, bạn thử lại sau nhé.');
});

test('history data: what each device reported and measures; a member sees alerts only', async () => {
    const context = buildHomeContext({
        catalog: await loadCatalog(),
        devices: [
            FIXTURE_DEVICES[0],
            FIXTURE_DEVICES[2],
            { ...FIXTURE_DEVICES[0], mac: 'AA:00:00:00:00:09', name: 'Cửa nhà bà', role: 'controller', room_id: null },
        ],
        rooms: new Map([['living', 'Phòng khách']]),
        shadows: FIXTURE_SHADOWS,
        scenes: [],
        automations: [{ id: 'x', name: 'Báo cửa mở', scene_id: null }],
        now: NOW,
    });
    const data = context.historyData as any;
    assert.equal(data.today, '2026-11-23');
    assert.equal(data.kept_days, 30);
    assert.deepEqual(data.automations, [{ id: 'u1', name: 'Báo cửa mở' }]);
    const [door, kitchen, grandma] = data.devices;
    assert.equal(door.id, 'd1');
    assert.equal(door.room, 'Phòng khách');
    assert.equal(door.sees, undefined);
    const doorEvents = door.events.map((event: any) => event.what);
    assert.ok(doorEvents.includes('Cửa được mở') && doorEvents.includes('Nhập đúng mã PIN'));
    assert.deepEqual(kitchen.readings.map((reading: any) => reading.what),
        ['Khí gas · Mức khí gas', 'Khói · Mức khói', 'Nhiệt độ DHT11 · Nhiệt độ', 'Độ ẩm DHT11 · Độ ẩm không khí'],
        'diagnostics are left out');
    assert.equal(kitchen.readings.find((reading: any) => reading.what.endsWith('Nhiệt độ')).unit, '°C');
    assert.equal(grandma.sees, 'alerts_only');
    const grandmaEvents = context.history[2].events;
    assert.ok(grandmaEvents.length > 0);
    assert.ok(!grandmaEvents.some(event => event.event_name === 'door_opened'), 'no access history for a member');
    assert.ok(grandmaEvents.some(event => event.event_name === 'pin_access_denied'));
    assert.deepEqual(chartsOf([{ what: 'commands', device: context.history[0], window: window({ period: 'last_days', amount: 3 })! }]),
        [{ mac: 'AA:00:00:00:00:01', device: 'Cửa chính', range: '7d' }]);
});

const fake = (calls: GeminiCall[], seen: GeminiRequest[] = []): GenerateFn => async (request) => {
    seen.push(request);
    return { text: null, calls, tokens: 1000, blocked: false };
};

test('history lookups: ids and periods checked, at most 3, none with a question back', async () => {
    const context = await fixtureContext();
    const door = historyId(context, 'Cửa chính');
    const kitchen = context.history.find(item => item.device === 'Bếp an toàn')!;
    const temperature = kitchen.readings.find(reading => reading.label === 'Nhiệt độ')!.id;
    const seen: GeminiRequest[] = [];
    const plan = await planTurn(fake([
        { name: 'look_up_history', args: { what: 'events', device_id: door, period: 'yesterday' } },
        { name: 'look_up_history', args: { what: 'events', device_id: door, period: 'yesterday' } },
        { name: 'look_up_history', args: { what: 'readings', device_id: kitchen.id, reading_id: temperature, period: 'last_days', amount: 7 } },
        { name: 'look_up_history', args: { what: 'runs', run_id: 's1', period: 'this_week' } },
        { name: 'look_up_history', args: { what: 'commands', device_id: door, period: 'today' } },
    ], seen), { context, history: [], message: 'hôm qua cửa chính mở mấy lần, nhiệt độ bếp tuần này, kịch bản đi ngủ có chạy không' });
    assert.deepEqual(plan.lookups.map(item => [item.what, item.what === 'runs' ? item.scene?.name : item.device.device, item.window.label]), [
        ['events', 'Cửa chính', 'hôm qua (20/11)'],
        ['readings', 'Bếp an toàn', '7 ngày qua (15/11 – 21/11)'],
        ['runs', 'Đi ngủ', 'tuần này (từ thứ Hai 16/11)'],
    ]);
    assert.deepEqual(plan.dropped, [{ name: 'look_up_history', reason: 'too_many' }], 'the duplicate counts once');
    const home = JSON.parse(seen[0].contents.at(-1)!.parts[0].text.split('\n').slice(1).join('\n'));
    assert.ok(home.history, 'a question about the past gets what may be looked up');
    assert.equal(home.history.today, '2026-11-21');

    const bad = await planTurn(fake([
        { name: 'look_up_history', args: { what: 'events', device_id: 'd99', period: 'today' } },
        { name: 'look_up_history', args: { what: 'events', device_id: door, period: 'tomorrow' } },
        { name: 'look_up_history', args: { what: 'readings', device_id: kitchen.id, period: 'today' } },
        { name: 'look_up_history', args: { what: 'events', device_id: door, event_ids: [kitchen.events[0].id], period: 'today' } },
        { name: 'look_up_history', args: { what: 'runs', run_id: 'u9', period: 'today' } },
        { name: 'look_up_history', args: { what: 'gossip', period: 'today' } },
    ]), { context, history: [], message: 'hôm nay thế nào' });
    assert.deepEqual(bad.lookups, []);
    assert.deepEqual(bad.dropped.map(item => item.reason), ['unknown_id', 'bad_value', 'missing_value', 'unknown_id', 'unknown_id', 'bad_value']);

    const unsure = await planTurn(fake([
        { name: 'look_up_history', args: { what: 'events', device_id: door, period: 'today' } },
        { name: 'ask_clarification', args: { question: 'Cửa nào?' } },
    ]), { context, history: [], message: 'hôm nay cửa mở mấy lần' });
    assert.deepEqual(unsure.lookups, []);
    assert.equal(unsure.clarification?.question, 'Cửa nào?');

    const plain: GeminiRequest[] = [];
    await planTurn(fake([], plain), { context, history: [], message: 'mở mái che' });
    assert.ok(!plain[0].contents.at(-1)!.parts[0].text.includes('"history"'), 'ordinary turns stay small');
    const followUp: GeminiRequest[] = [];
    await planTurn(fake([], followUp), {
        context, message: 'còn cửa sau?',
        history: [{ role: 'user', text: 'hôm qua cửa chính mở mấy lần' }, { role: 'model', text: 'Hôm qua mở 3 lần.', history: true }],
    });
    assert.ok(followUp[0].contents.at(-1)!.parts[0].text.includes('"history"'), 'a follow-up of a history answer');
});

test('questions about the past are recognized, tone marks or not', () => {
    for (const said of ['Hôm qua cửa mở mấy lần?', 'lan cuoi cua mo luc nao', 'vườn đã được tưới chưa', 'nhiệt độ cao nhất tuần này',
        'tối qua có ai mở cửa không', 'kịch bản đi ngủ có chạy không']) {
        assert.ok(mayBeHistory(said), said);
    }
    for (const said of ['mở mái che', 'cửa đang khóa không?', 'kể chuyện cười đi', 'bật còi thử']) {
        assert.ok(!mayBeHistory(said), said);
    }
});

// ── Full turns ────────────────────────────────────────────────────────────

test.describe('assistant history', { skip: skipWithoutMongo }, () => {
    let db: TestDatabase;
    let app: FastifyInstance;
    let mongo: MongoClient;
    let server: http.Server;
    /** The stand-in Gemini: [plan] answers the first call, [answer] the one with the facts. */
    let plan: (home: any) => any;
    let answer: (facts: any[]) => string;
    const requests: any[] = [];

    test.before(async () => {
        db = await createTestDatabase();
        mongo = await new MongoClient(TEST_MONGO_URL).connect();
        app = await buildTestApp(db.pool, [assistantRoutes], { client: mongo, db: mongo.db(`assistant_history_${Date.now()}`) });
        server = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on('data', chunk => chunks.push(chunk));
            req.on('end', () => {
                const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                requests.push(request);
                const data = request.contents.at(-1).parts[0].text;
                const json = JSON.parse(data.slice(data.indexOf('\n') + 1));
                if (request.tools && !json.history) {
                    res.writeHead(500);
                    res.end('{}');
                    return;
                }
                const body = request.tools
                    ? { candidates: [{ content: { parts: [plan(json)].flat().map((call: any) => ({ functionCall: call })) }, finishReason: 'STOP' }],
                        usageMetadata: { totalTokenCount: 1000 } }
                    : { candidates: [{ content: { parts: [{ text: answer(json) }] }, finishReason: 'STOP' }],
                        usageMetadata: { totalTokenCount: 400 } };
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify(body));
            });
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        env.GEMINI_API_KEY = 'test-key';
        env.GEMINI_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    test.after(async () => {
        await app?.mongo.db.dropDatabase().catch(() => undefined);
        await app?.close();
        await mongo?.close();
        await new Promise(resolve => server?.close(resolve));
        await db?.drop();
    });

    const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);
    const ask = (user: SignedInUser, text: string) =>
        app.inject({ method: 'POST', url: '/assistant/message', headers: user.headers, payload: { text } });

    async function ownedSince(user: SignedInUser, options: { name: string; productId: string; catalogRevision: number }) {
        const device = await createOwnedDevice(db.pool, user.id, options);
        await db.pool.query(`UPDATE device_memberships SET created_at = NOW() - interval '3 days' WHERE device_id = $1`, [device.id]);
        return device;
    }

    async function event(mac: string, ownerId: string, instance: string, name: string, severity: string, at: Date, data: object = {}) {
        await app.mongo.db.collection('device_events').insertOne({
            _id: new ObjectId(), event_id: `evt-${new ObjectId()}`, device_id: mac, owner_id: ownerId, instance_id: instance,
            event_name: name, severity, received_at: at, occurred_at: at, data,
        } as any);
    }

    async function command(device: { id: string }, actorId: string, instance: string, operation: string, at: Date, status = 'succeeded') {
        const permission = (app.catalog.getOperation('prod_entrance_controller', instance, operation) as any).permission;
        await db.pool.query(
            `INSERT INTO device_operations (device_id, actor_account_id, instance_id, operation_name, permission_scope,
                risk, status, catalog_revision, accepted_at, created_at, timeout_at, completed_at)
             VALUES ($1, $2, $3, $4, $5, 'normal', $6, 6, $7, $7, $7::timestamptz + interval '30 seconds', $7)`,
            [device.id, actorId, instance, operation, permission, status, at],
        );
    }

    const lookup = (what: string, extra: object = {}) => (home: any) => ({
        name: 'look_up_history',
        args: { what, device_id: home.history.devices[0]?.id, period: 'last_hours', amount: 24, ...extra },
    });

    test('the owner hears every event of the last day, from the facts', async () => {
        const owner = await signUp(app);
        const door = await ownedSince(owner, { name: 'Cửa chính', productId: 'prod_entrance_controller', catalogRevision: 6 });
        await event(door.mac, owner.id, 'door_position', 'door_opened', 'info', hoursAgo(5));
        await event(door.mac, owner.id, 'door_position', 'door_opened', 'info', hoursAgo(2));
        await event(door.mac, owner.id, 'pin_auth', 'pin_access_denied', 'warning', hoursAgo(1), { attempts_remaining: 2 });
        await event(door.mac, owner.id, 'door_position', 'door_opened', 'info', hoursAgo(30), {}); // older than the period
        await event(door.mac, 'previous-owner', 'door_position', 'door_opened', 'info', hoursAgo(3)); // not this owner's

        plan = lookup('events');
        let facts: any[] = [];
        answer = (found) => {
            facts = found;
            return `Trong 24 giờ qua cửa được mở ${found[0].by_event.find((item: any) => item.what === 'Cửa được mở').count} lần.`;
        };
        const reply = await ask(owner, 'hôm qua tới giờ cửa mở mấy lần?');
        assert.equal(reply.statusCode, 200, reply.body);
        const body = reply.json();
        assert.equal(body.outcome, 'chat');
        assert.equal(body.reply, 'Trong 24 giờ qua cửa được mở 2 lần.');
        assert.deepEqual(body.charts, [{ mac: door.mac, device: 'Cửa chính', range: '24h' }]);
        assert.equal(facts[0].device, 'Cửa chính');
        assert.equal(facts[0].total, 3);
        assert.equal(facts[0].sees, undefined);
        assert.deepEqual(facts[0].latest.map((item: any) => [item.what, item.detail ?? null]),
            [['Nhập sai mã PIN', 'còn 2 lần thử'], ['Cửa được mở', null], ['Cửa được mở', null]]);
        assert.equal(requests.at(-1).tools, undefined, 'the answer is asked without functions');
        assert.equal(body.usage.used_tokens, 1400, 'both calls count');

        const turn = (await db.pool.query('SELECT outcome, tokens, actions FROM assistant_turns WHERE account_id = $1', [owner.id])).rows[0];
        assert.equal(turn.tokens, 1400);
        assert.deepEqual(turn.actions, [{ kind: 'history', what: 'events', target: 'Cửa chính', period: '24 giờ qua', grounded: true }]);

        // A count the model made up is replaced by the server's sentence (99: never a time or a date in the facts).
        answer = () => 'Cửa được mở 99 lần.';
        const invented = (await ask(owner, 'hôm qua tới giờ cửa mở mấy lần?')).json();
        assert.match(invented.reply, /^24 giờ qua, Cửa chính: cửa được mở 2 lần \(gần nhất \d\d:\d\d \d\d\/\d\d\); nhập sai mã pin 1 lần/);
    });

    test('a member sees only the alerts and their own commands; the owner sees who did what', async () => {
        const owner = await signUp(app, { fullName: 'Chủ nhà' });
        const member = await signUp(app, { fullName: 'Lan' });
        const door = await ownedSince(owner, { name: 'Cửa chung', productId: 'prod_entrance_controller', catalogRevision: 6 });
        await addMember(db.pool, door, owner.id, member.id, 'controller');
        await db.pool.query(`UPDATE device_memberships SET created_at = NOW() - interval '2 hours' WHERE account_id = $1`, [member.id]);
        await event(door.mac, owner.id, 'door_position', 'door_opened', 'info', hoursAgo(0.5));
        await event(door.mac, owner.id, 'pin_auth', 'pin_access_denied', 'warning', hoursAgo(0.4));
        await event(door.mac, owner.id, 'pin_auth', 'pin_access_denied', 'warning', hoursAgo(20)); // before Lan joined
        await command(door, owner.id, 'main_lock', 'unlock', hoursAgo(0.3));
        await command(door, member.id, 'main_lock', 'lock', hoursAgo(0.2));
        await command(door, member.id, 'main_lock', 'lock', hoursAgo(0.1), 'failed');

        let facts: any[] = [];
        answer = (found) => {
            facts = found;
            return 'Đây là kết quả.';
        };
        plan = lookup('events');
        await ask(member, 'hôm nay cửa có gì không?');
        assert.equal(facts[0].sees, 'alerts_only');
        assert.equal(facts[0].total, 1, 'warnings only, from the day the member joined');
        assert.deepEqual(facts[0].by_event.map((item: any) => item.what), ['Nhập sai mã PIN']);

        plan = lookup('commands');
        await ask(member, 'hôm nay ai khóa cửa?');
        assert.equal(facts[0].only_yours, true);
        assert.equal(facts[0].total, 2);
        assert.deepEqual(facts[0].latest.map((item: any) => [item.what, item.by, item.result ?? null]),
            [['Khóa cửa', 'bạn', 'không thành công'], ['Khóa cửa', 'bạn', null]]);

        await ask(owner, 'hôm nay ai khóa cửa?');
        assert.equal(facts[0].only_yours, undefined);
        assert.equal(facts[0].total, 3);
        assert.deepEqual(facts[0].latest.map((item: any) => item.by), ['Lan', 'Lan', 'bạn']);
        assert.deepEqual(facts[0].by_command, [{ what: 'Khóa cửa', count: 2, not_succeeded: 1 }, { what: 'Mở khóa', count: 1 }]);
    });

    test('readings: highest, lowest, average and when; runs of the account\'s scenes', async () => {
        const owner = await signUp(app);
        const kitchen = await ownedSince(owner, { name: 'Bếp', productId: 'prod_hazard_mitigation', catalogRevision: 6 });
        for (const [hours, temperature] of [[10, 28.54], [6, 34.5], [3, 30]] as const) {
            await app.mongo.db.collection('device_telemetry').insertOne({
                _id: new ObjectId(), observed_at: hoursAgo(hours),
                metadata: { device_id: kitchen.mac, owner_id: owner.id, product_id: 'prod_hazard_mitigation' },
                instances: { kitchen_temperature: { reported: { temperature } } },
            } as any);
        }
        let facts: any[] = [];
        answer = (found) => {
            facts = found;
            return `Cao nhất ${found[0].highest.value}°C.`;
        };
        plan = (home) => {
            const device = home.history.devices[0];
            const reading = device.readings.find((item: any) => item.what.endsWith('Nhiệt độ'));
            return { name: 'look_up_history', args: { what: 'readings', device_id: device.id, reading_id: reading.id, period: 'last_hours', amount: 24 } };
        };
        const reply = (await ask(owner, 'nhiệt độ bếp cao nhất bao nhiêu trong 24 giờ qua?')).json();
        assert.equal(reply.reply, 'Cao nhất 34.5°C.');
        assert.equal(facts[0].reading, 'Nhiệt độ DHT11 · Nhiệt độ');
        assert.equal(facts[0].unit, '°C');
        assert.equal(facts[0].samples, 3);
        assert.deepEqual([facts[0].highest.value, facts[0].lowest.value, facts[0].average, facts[0].latest.value], [34.5, 28.5, 31, 30]);

        for (const [hours, trigger, status] of [[5, 'schedule', 'succeeded'], [1, 'manual', 'partial']] as const) {
            await db.pool.query(
                `INSERT INTO scene_runs (account_id, scene_name, trigger, status, started_at, finished_at)
                 VALUES ($1, 'Đi ngủ', $2, $3, $4, $4)`,
                [owner.id, trigger, status, hoursAgo(hours)],
            );
        }
        plan = () => ({ name: 'look_up_history', args: { what: 'runs', period: 'last_hours', amount: 24 } });
        answer = (found) => {
            facts = found;
            return 'Có.';
        };
        const runs = (await ask(owner, '24 giờ qua kịch bản nào đã chạy?')).json();
        assert.deepEqual(runs.charts, [], 'no device chart for scenes');
        assert.equal(facts[0].of, null);
        assert.deepEqual(facts[0].by_scene, [{ name: 'Đi ngủ', count: 2 }]);
        assert.deepEqual(facts[0].latest.map((item: any) => [item.scene, item.how, item.result]),
            [['Đi ngủ', 'chạy bằng tay', 'chỉ xong một phần'], ['Đi ngủ', 'theo hẹn giờ', 'thành công']]);
    });

    test('too old periods and failed lookups get the server\'s words; commands run alongside', async () => {
        const owner = await signUp(app);
        const door = await ownedSince(owner, { name: 'Cửa trước', productId: 'prod_entrance_controller', catalogRevision: 6 });
        plan = (home) => ({ name: 'look_up_history', args: { what: 'events', device_id: home.history.devices[0].id, period: 'dates', from_date: '2025-01-01' } });
        answer = () => 'Năm ngoái cửa mở 2025 lần.';
        const old = (await ask(owner, 'tháng 1 năm ngoái cửa mở mấy lần?')).json();
        assert.match(old.reply, /chỉ lưu lịch sử 30 ngày/);
        assert.deepEqual(old.charts, []);

        plan = (home) => {
            const device = home.devices[0];
            const lock = device.actions.find((action: any) => action.do.endsWith('Khóa cửa')).id;
            return [
                { name: 'look_up_history', args: { what: 'events', device_id: home.history.devices[0].id, period: 'today' } },
                { name: 'control_device', args: { action_id: lock, quote: 'khóa cửa lại' } },
            ];
        };
        answer = () => 'Hôm nay cửa chưa mở lần nào.';
        const both = (await ask(owner, 'Hôm nay cửa mở mấy lần rồi? Khóa cửa lại giúp tôi')).json();
        assert.equal(both.reply, 'Hôm nay cửa chưa mở lần nào. Đã gửi lệnh "Khóa cửa" (Cửa trước).');
        assert.equal(both.outcome, 'action');
        const sent = await db.pool.query('SELECT operation_name FROM device_operations WHERE device_id = $1', [door.id]);
        assert.deepEqual(sent.rows.map(row => row.operation_name), ['lock']);
    });
});
