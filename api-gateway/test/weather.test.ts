import './setup-env';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { MongoClient } from 'mongodb';
import { env } from '../src/config/env';
import adminRoutes from '../src/modules/admin/routes';
import { createRootStaff } from '../src/modules/admin/staff';
import { buildHomeContext } from '../src/modules/assistant/context';
import { checkDraft, draftView } from '../src/modules/assistant/drafts';
import type { GeminiCall, GeminiRequest, GenerateFn } from '../src/modules/assistant/gemini';
import { answerIsGrounded, type HistoryFacts } from '../src/modules/assistant/history';
import { planTurn } from '../src/modules/assistant/planner';
import assistantRoutes from '../src/modules/assistant/routes';
import { answerFallback, checkWeatherLookup, weatherFacts, type WeatherLookup } from '../src/modules/assistant/weatherLookup';
import automationRoutes from '../src/modules/automations/routes';
import { runDueAutomations } from '../src/modules/automations/firing';
import sceneRoutes from '../src/modules/scenes/routes';
import {
    compareWeather,
    isFresh,
    mockSnapshot,
    snapshotFromOpenMeteo,
    validWeatherComparison,
    weatherConditionText,
    type WeatherHour,
    type WeatherSnapshot,
    weatherSummary,
    weatherValue,
} from '../src/modules/weather/forecast';
import {
    AREAS,
    areasOf,
    findArea,
    findProvince,
    mainAreaOf,
    nearestArea,
    placeOf,
    PROVINCES,
} from '../src/modules/weather/provinces';
import weatherRoutes from '../src/modules/weather/routes';
import { clearAccountMock, locationOf, refreshForecasts, setMock } from '../src/modules/weather/service';
import { FIXTURE_DEVICES, FIXTURE_SHADOWS, fixtureContext, loadCatalog } from './assistant/fixture';
import { createTestDatabase, skipWithoutMongo, TEST_MONGO_URL, TestDatabase } from './helpers/testDatabase';
import { buildTestApp, signUp, SignedInUser } from './helpers/testApp';
import { createOwnedDevice } from './helpers/fixtures';

const HOUR = 3_600_000;
// Monday 23/11/2026, 13:20 in Hà Nội.
const NOON = new Date('2026-11-23T06:20:00Z');
// Monday 23/11/2026, 20:14 in Hà Nội.
const EVENING = new Date('2026-11-23T13:14:00Z');
const MIDNIGHT = Date.parse('2026-11-22T17:00:00Z'); // 00:00 23/11 in Hà Nội

/** A live forecast of 3 days from local midnight: rain only at 15:00 today. */
function liveSnapshot(fetchedAt: Date, current: Partial<WeatherSnapshot['current']> = {}): WeatherSnapshot {
    const hours: WeatherHour[] = [];
    for (let index = 0; index < 72; index += 1) {
        const localHour = index % 24;
        const rain = index === 15;
        hours.push({
            at: new Date(MIDNIGHT + index * HOUR).toISOString(),
            temperature: 24 + (localHour >= 10 && localHour <= 16 ? 8 : 0) + Math.floor(index / 24),
            precipitation_probability: rain ? 80 : 10,
            precipitation: rain ? 2 : 0,
            weather_code: rain ? 61 : 1,
        });
    }
    return {
        source: 'open-meteo',
        fetched_at: fetchedAt.toISOString(),
        current: { temperature: 30.4, precipitation: 0, weather_code: 1, ...current },
        hours,
    };
}

// ── The forecast and the conditions ───────────────────────────────────────

test('conditions read the forecast; unknown or old weather is never met', () => {
    const snapshot = liveSnapshot(new Date(NOON.getTime() - 20 * 60_000));
    assert.equal(weatherValue(snapshot, 'rain_now', NOON), false);
    assert.equal(weatherValue(snapshot, 'rain_next_1h', NOON), false);
    assert.equal(weatherValue(snapshot, 'rain_next_3h', NOON), true, 'rain at 15:00');
    assert.equal(weatherValue(snapshot, 'rain_next_12h', NOON), true);
    assert.equal(weatherValue(snapshot, 'temperature', NOON), 30.4);
    assert.equal(weatherValue(snapshot, 'temperature_max_today', NOON), 32);
    assert.equal(weatherValue(snapshot, 'nonsense', NOON), undefined);

    const old = liveSnapshot(new Date(NOON.getTime() - 4 * HOUR));
    assert.equal(isFresh(old, NOON), false);
    for (const id of ['rain_now', 'rain_next_3h', 'temperature', 'temperature_max_today']) {
        assert.equal(weatherValue(old, id, NOON), undefined, id);
    }
    assert.equal(weatherValue(null, 'rain_now', NOON), undefined);
    assert.equal(weatherValue(liveSnapshot(NOON, { precipitation: null, weather_code: null }), 'rain_now', NOON), undefined);
    assert.equal(weatherValue(liveSnapshot(NOON, { weather_code: 63 }), 'rain_now', NOON), true);
    // An hour after the request, "now" is the forecast of the current hour, not the request's "current".
    const later = new Date(NOON.getTime() + 2 * HOUR + 10 * 60_000); // 15:30
    assert.equal(weatherValue(snapshot, 'rain_now', later), true, 'the 15:00 hour has rain');
    assert.equal(weatherValue(snapshot, 'temperature', later), 32);
    assert.equal(weatherSummary(snapshot, later).current.raining, true);

    assert.equal(compareWeather(undefined, 'eq', false), false, 'unknown is not met, whatever is asked');
    assert.equal(compareWeather(false, 'eq', false), true);
    assert.equal(compareWeather(36, 'gt', 35), true);
    assert.equal(compareWeather(36, 'lt', 35), false);
    assert.equal(validWeatherComparison('rain_now', 'eq', true), true);
    assert.equal(validWeatherComparison('rain_now', 'gt', 1), false);
    assert.equal(validWeatherComparison('temperature', 'gt', 60), false);
    assert.equal(validWeatherComparison('temperature', 'eq', 30), false);
    assert.equal(validWeatherComparison('snow', 'eq', true), false);
    assert.equal(weatherConditionText('rain_next_12h', 'eq', false), 'Không mưa trong 12 giờ tới');
    assert.equal(weatherConditionText('rain_now', 'eq', false), 'Trời không mưa');
    assert.equal(weatherConditionText('rain_next_3h', 'eq', true), 'Có mưa trong 3 giờ tới');
    assert.equal(weatherConditionText('temperature', 'gt', 35), 'Nhiệt độ ngoài trời trên 35°C');
});

test('mock scenarios play what the Console set, from now on', () => {
    const raining = mockSnapshot({ scenario: 'raining' }, NOON);
    assert.equal(weatherValue(raining, 'rain_now', NOON), true);
    assert.equal(weatherValue(raining, 'rain_next_1h', NOON), true);
    const soon = mockSnapshot({ scenario: 'rain_soon', rain_in_hours: 3 }, NOON);
    assert.equal(weatherValue(soon, 'rain_now', NOON), false);
    assert.equal(weatherValue(soon, 'rain_next_1h', NOON), false);
    assert.equal(weatherValue(soon, 'rain_next_6h', NOON), true);
    const sunny = mockSnapshot({ scenario: 'sunny' }, NOON);
    assert.equal(weatherValue(sunny, 'rain_next_12h', NOON), false);
    assert.equal(weatherValue(sunny, 'temperature', NOON), 31);
    assert.ok((weatherValue(mockSnapshot({ scenario: 'heat' }, NOON), 'temperature_max_today', NOON) as number) > 35);
    assert.equal(weatherValue(mockSnapshot({ scenario: 'sunny', temperature: 18 }, NOON), 'temperature', NOON), 18);
    assert.equal(sunny.hours.length, 72);
    assert.ok(isFresh(mockSnapshot({ scenario: 'sunny' }, new Date(0)), NOON), 'a mock never gets old');
});

test('Open-Meteo answers become forecasts in UTC', () => {
    const snapshot = snapshotFromOpenMeteo({
        utc_offset_seconds: 25200,
        current: { temperature_2m: 29.4, precipitation: 0.2, weather_code: 61 },
        hourly: {
            time: ['2026-11-23T00:00', '2026-11-23T01:00'],
            temperature_2m: [24.1, null],
            precipitation_probability: [10, 70],
            precipitation: [0, 1.2],
            weather_code: [3, 61],
        },
    }, NOON)!;
    assert.equal(snapshot.source, 'open-meteo');
    assert.equal(snapshot.hours[0].at, '2026-11-22T17:00:00.000Z');
    assert.equal(snapshot.hours[1].temperature, null);
    assert.equal(snapshot.hours[1].precipitation_probability, 70);
    assert.equal(snapshotFromOpenMeteo({}, NOON), null);
    const summary = weatherSummary(snapshot, NOON);
    assert.equal(summary.current.temperature, 29);
    assert.equal(summary.current.raining, true);
    assert.equal(summary.current.description, 'Mưa');
    assert.equal(summary.rain_in_hours, 0);
});

test('34 provinces, 63 areas (the provinces before 2025), each province centred on one of its areas', () => {
    assert.equal(PROVINCES.length, 34);
    assert.equal(new Set(PROVINCES.map(item => item.code)).size, 34);
    assert.equal(AREAS.length, 63);
    assert.equal(new Set(AREAS.map(item => item.code)).size, 63);
    for (const province of PROVINCES) {
        const areas = areasOf(province.code);
        assert.ok(areas.length >= 1 && areas.length <= 3, province.code);
        assert.equal(areas[0], mainAreaOf(province), `${province.code}: its centre first`);
    }
    assert.equal(PROVINCES.filter(province => areasOf(province.code).length > 1).length, 23, '23 provinces were merged');
    assert.deepEqual(areasOf('ho_chi_minh').map(item => item.name), ['TP. Hồ Chí Minh', 'Bình Dương', 'Bà Rịa – Vũng Tàu']);
    assert.equal(mainAreaOf(findProvince('lao_cai')!).code, 'yen_bai', 'Lào Cai is run from Yên Bái');
    assert.equal(findProvince('Hà Nội'), null, 'by code only');
    assert.equal(findArea('binh_duong')?.province, 'ho_chi_minh');
    assert.equal(placeOf(findArea('binh_duong')!), 'Bình Dương (TP. Hồ Chí Minh)');
    assert.equal(placeOf(findArea('ha_noi')!), 'Hà Nội');
    for (const area of AREAS) assert.equal(nearestArea(area.latitude, area.longitude), area, area.code);

    // A home stored by ward before the areas existed reads as the area around it.
    assert.equal(locationOf({ home_latitude: 21.03, home_longitude: 105.81 })?.area, 'ha_noi', 'Ba Đình');
    assert.equal(locationOf({ home_latitude: 21.02, home_longitude: 105.93 })?.area, 'ha_noi', 'Gia Lâm');
    assert.deepEqual(locationOf({ home_latitude: '10.98', home_longitude: '106.67' }), {
        area: 'binh_duong', province: 'ho_chi_minh', place: 'Bình Dương (TP. Hồ Chí Minh)', latitude: 10.98, longitude: 106.65,
    }, 'Thủ Dầu Một, as Postgres returns numerics');
    assert.equal(locationOf({ home_latitude: null, home_longitude: null }), null);
    assert.equal(locationOf(undefined), null);
});

// ── The assistant ─────────────────────────────────────────────────────────

const look = (args: Record<string, unknown>, now = EVENING) => {
    const checked = checkWeatherLookup(args, now);
    assert.ok(checked.ok, JSON.stringify(args));
    return (checked as { lookup: WeatherLookup }).lookup;
};

test('weather questions: a day, a part of it, or the next hours, checked', () => {
    const afternoon = look({ when: 'tomorrow', from_hour: 12, to_hour: 18 });
    assert.equal(afternoon.start.toISOString(), '2026-11-24T05:00:00.000Z');
    assert.equal(afternoon.end.toISOString(), '2026-11-24T11:00:00.000Z');
    assert.equal(afternoon.label, 'ngày mai (24/11), 12:00–18:00');
    const today = look({ when: 'today' });
    assert.equal(today.start.toISOString(), '2026-11-22T17:00:00.000Z');
    assert.equal(today.end.toISOString(), '2026-11-23T17:00:00.000Z');
    assert.equal(today.label, 'hôm nay (23/11)');
    assert.equal(look({ when: 'day_after' }).label, 'ngày kia (25/11)');
    const next = look({ when: 'next_hours', amount: 6 });
    assert.equal(next.end.getTime() - next.start.getTime(), 6 * HOUR);
    assert.equal(next.label, '6 giờ tới');
    assert.equal(look({ when: 'now' }).label, 'bây giờ');
    for (const [args, reason] of [
        [{}, 'missing_value'], [{ when: 'next_week' }, 'bad_value'], [{ when: 'next_hours' }, 'bad_value'],
        [{ when: 'next_hours', amount: 30 }, 'bad_value'], [{ when: 'today', from_hour: 18, to_hour: 12 }, 'bad_value'],
        [{ when: 'today', to_hour: 25 }, 'bad_value'], [{ when: 'today', from_hour: 'chiều' }, 'bad_value'],
    ] as const) {
        assert.deepEqual(checkWeatherLookup(args as Record<string, unknown>, EVENING), { ok: false, reason }, JSON.stringify(args));
    }
});

test('weather facts, the number check and the server\'s own sentence', () => {
    // It rains from 22:00 for 4 hours.
    const soon = mockSnapshot({ scenario: 'rain_soon', rain_in_hours: 2 }, EVENING);
    const tonight = weatherFacts(look({ when: 'today', from_hour: 18, to_hour: 24 }), soon, 'Hà Nội', EVENING);
    assert.equal(tonight.kind, 'weather');
    assert.equal(tonight.place, 'Hà Nội');
    assert.equal(tonight.mock, true);
    assert.equal(tonight.rain, true);
    assert.deepEqual(tonight.rain_hours, ['22:00', '23:00']);
    assert.equal(tonight.max_rain_chance, 90);
    assert.equal(typeof tonight.highest, 'number');

    const now = weatherFacts(look({ when: 'now' }), soon, 'Hà Nội', EVENING);
    assert.equal(now.temperature, 28);
    assert.equal(now.raining, false);
    assert.equal(now.rain_in_hours, 2);

    const tomorrow = weatherFacts(look({ when: 'tomorrow' }), mockSnapshot({ scenario: 'sunny' }, EVENING), 'Hà Nội', EVENING);
    assert.equal(tomorrow.rain, false);
    assert.equal(tomorrow.rain_hours, undefined);

    const nowhere = weatherFacts(look({ when: 'today' }), null, null, EVENING);
    assert.deepEqual(nowhere, { kind: 'weather', period: 'hôm nay (23/11)', no_location: true });
    const stale = weatherFacts(look({ when: 'today' }), liveSnapshot(new Date(EVENING.getTime() - 5 * HOUR)), 'Hà Nội', EVENING);
    assert.equal(stale.unavailable, true);

    const message = 'tối nay có mưa không?';
    assert.ok(answerIsGrounded('Theo dự báo, tối nay ở Hà Nội có thể mưa từ 22:00, khả năng đến 90%.', [tonight], message));
    assert.ok(!answerIsGrounded('Theo dự báo, tối nay mưa khả năng 99%.', [tonight], message));

    const runs: HistoryFacts = { kind: 'runs', period: 'hôm nay (23/11)', total: 0 };
    const fallback = answerFallback([tonight, runs]);
    assert.match(fallback, /^Theo dự báo, hôm nay \(23\/11\), 18:00–24:00 ở Hà Nội: \d+–\d+°C, có thể mưa khoảng 22:00, 23:00 \(khả năng đến 90%\)\./);
    assert.match(fallback, /các kịch bản không chạy lần nào\.$/);
    assert.match(answerFallback([tomorrow]), /^Theo dự báo, ngày mai \(24\/11\) ở Hà Nội: \d+–\d+°C, không có mưa\.$/);
    assert.match(answerFallback([now]), /^Theo dự báo, bây giờ ở Hà Nội khoảng 28°C/);
    assert.match(answerFallback([nowhere]), /Cá nhân → Vị trí nhà & thời tiết/);
    assert.equal(answerFallback([stale]), 'Mình chưa lấy được dự báo thời tiết lúc này, bạn thử lại sau nhé.');
});

const fake = (calls: GeminiCall[], seen: GeminiRequest[] = []): GenerateFn => async (request) => {
    seen.push(request);
    return { text: null, calls, tokens: 10, blocked: false };
};
const homeData = (request: GeminiRequest) => {
    const text = request.contents.at(-1)!.parts[0].text;
    return JSON.parse(text.slice(text.indexOf('\n') + 1));
};

test('the planner: forecasts to read, at most 2, none with a question back', async () => {
    const context = await fixtureContext();
    const seen: GeminiRequest[] = [];
    const plan = await planTurn(fake([
        { name: 'look_up_weather', args: { when: 'today' } },
        { name: 'look_up_weather', args: { when: 'today' } },
        { name: 'look_up_weather', args: { when: 'tomorrow', from_hour: 12, to_hour: 18 } },
        { name: 'look_up_weather', args: { when: 'day_after' } },
        { name: 'look_up_weather', args: { when: 'yesterday' } },
    ], seen), { context, history: [], message: 'hôm nay và chiều mai có mưa không?' });
    assert.deepEqual(plan.weather.map(item => item.label), ['hôm nay (21/11)', 'ngày mai (22/11), 12:00–18:00']);
    assert.deepEqual(plan.dropped, [{ name: 'look_up_weather', reason: 'too_many' }, { name: 'look_up_weather', reason: 'bad_value' }]);
    assert.deepEqual(homeData(seen[0]).weather, { place: 'Hà Nội' });

    const unsure = await planTurn(fake([
        { name: 'look_up_weather', args: { when: 'today' } },
        { name: 'ask_clarification', args: { question: 'Bạn hỏi hôm nay hay ngày mai?' } },
    ]), { context, history: [], message: 'mưa không?' });
    assert.deepEqual(unsure.weather, []);
    assert.deepEqual(unsure.dropped, [{ name: 'look_up_weather', reason: 'ambiguous' }]);
});

test('weather in the home data: a "Nếu" condition at home, never a trigger', async () => {
    const context = await fixtureContext();
    const entry = context.automationData.at(-1) as any;
    assert.equal(entry.device, 'Thời tiết ở Hà Nội');
    assert.equal(entry.watch.length, 7);
    assert.ok(entry.watch.every((item: any) => item.only === 'nếu'));
    assert.equal(new Set(context.watches.map(watch => watch.id)).size, context.watches.length, 'every id once');
    const dry = context.watches.find(watch => watch.weather === 'rain_next_12h')!;
    const water = context.actions.find(action => action.device === 'Tưới vườn' && action.label === 'Bắt đầu tưới')!;

    const checked = checkDraft({
        name: 'Tưới sáng', trigger: 'time', time: '06:00',
        conditions: [{ watch_id: dry.id, operator: 'eq', value: 'false' }],
        steps: [{ action_id: water.id, value: '600' }], quote: 'tưới vườn nếu không mưa',
    }, context);
    assert.ok(checked.ok);
    const draft = (checked as any).draft;
    assert.equal(draft.conditions[0].value, false);
    assert.deepEqual(draftView('d1', draft).conditions, ['Nếu Thời tiết: Không mưa trong 12 giờ tới']);
    const hot = context.watches.find(watch => watch.weather === 'temperature_max_today')!;
    assert.equal((checkDraft({
        name: 'Nóng', trigger: 'time', time: '17:00', conditions: [{ watch_id: hot.id, operator: 'gt', value: '35' }],
        steps: [{ action_id: water.id, value: '900' }],
    }, context) as any).draft.conditions[0].value, 35);
    assert.deepEqual(checkDraft({
        name: 'Mưa', trigger: 'watch', watch_id: dry.id, operator: 'eq', value: 'true', steps: [{ action_id: water.id, value: '60' }],
    }, context), { ok: false, reason: 'unknown_id' }, 'the weather is not a trigger');
    assert.deepEqual(checkDraft({
        name: 'Nóng', trigger: 'time', time: '17:00', conditions: [{ watch_id: hot.id, operator: 'gt', value: '70' }],
        steps: [{ action_id: water.id, value: '900' }],
    }, context), { ok: false, reason: 'bad_value' });

    const base = { catalog: await loadCatalog(), devices: FIXTURE_DEVICES, rooms: new Map(), shadows: FIXTURE_SHADOWS, scenes: [] };
    const off = buildHomeContext(base);
    assert.ok(!('weather' in off.data), 'weather off: nothing about it');
    assert.ok(!off.watches.some(watch => watch.weather));
    const unset = buildHomeContext({ ...base, weather: null });
    assert.equal(unset.data.weather, null, 'no home location yet');
    assert.ok(!unset.watches.some(watch => watch.weather));
});

// ── Through the API ───────────────────────────────────────────────────────

test.describe('weather', { skip: skipWithoutMongo }, () => {
    const KEY = 'test-admin-key-0123456789-abcdefghijklmnop';
    const ZONE = 'Asia/Ho_Chi_Minh';
    let db: TestDatabase;
    let app: FastifyInstance;
    let mongo: MongoClient;
    let rootSession = '';
    /** Stand-ins for Open-Meteo and Gemini on one local server. */
    let server: http.Server;
    /** Each location asked for ("10.98,106.65"), and how many requests. */
    const forecastCalls: string[] = [];
    let forecastRequests = 0;
    /** Open-Meteo answers 500 while true. */
    let failing = false;
    let plan: (home: any) => any = () => [];
    let answer: (facts: any[]) => string = () => '';
    const planned: any[] = [];

    function openMeteo(url: URL) {
        forecastRequests += 1;
        if (failing) return null;
        const latitudes = url.searchParams.get('latitude')!.split(',');
        const longitudes = url.searchParams.get('longitude')!.split(',');
        const day = new Date(Date.now() + 7 * HOUR).toISOString().slice(0, 10);
        const first = Date.parse(`${day}T00:00:00Z`);
        const time = Array.from({ length: 72 }, (_, index) => new Date(first + index * HOUR).toISOString().slice(0, 16));
        const answers = latitudes.map((latitude, index) => {
            forecastCalls.push(`${latitude},${longitudes[index]}`);
            return {
                utc_offset_seconds: 25200,
                current: { temperature_2m: 27.6, precipitation: 0, weather_code: 2 },
                hourly: {
                    time,
                    temperature_2m: time.map(() => 27),
                    precipitation_probability: time.map(() => 5),
                    precipitation: time.map(() => 0),
                    weather_code: time.map(() => 2),
                },
            };
        });
        return answers.length === 1 ? answers[0] : answers;
    }

    function gemini(request: any) {
        const text = request.contents.at(-1).parts[0].text;
        const json = JSON.parse(text.slice(text.indexOf('\n') + 1));
        if (request.tools) {
            planned.push(json);
            return {
                candidates: [{ content: { parts: [plan(json)].flat().map((call: any) => ({ functionCall: call })) }, finishReason: 'STOP' }],
                usageMetadata: { totalTokenCount: 1000 },
            };
        }
        return { candidates: [{ content: { parts: [{ text: answer(json) }] }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 300 } };
    }

    test.before(async () => {
        Object.assign(env, { ADMIN_API_KEY: KEY, WEATHER_MODE: 'mock' });
        db = await createTestDatabase();
        mongo = await new MongoClient(TEST_MONGO_URL).connect();
        app = await buildTestApp(db.pool, [weatherRoutes, sceneRoutes, automationRoutes, adminRoutes, assistantRoutes], {
            client: mongo, db: mongo.db(`weather_${Date.now()}`),
        });
        server = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on('data', chunk => chunks.push(chunk));
            req.on('end', () => {
                const url = new URL(req.url!, 'http://local');
                const body = url.pathname.startsWith('/gemini')
                    ? gemini(JSON.parse(Buffer.concat(chunks).toString('utf8'))) : openMeteo(url);
                res.writeHead(body === null ? 500 : 200, { 'content-type': 'application/json' });
                res.end(JSON.stringify(body));
            });
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        Object.assign(env, {
            WEATHER_API_URL: `${base}/v1`,
            GEMINI_API_KEY: 'test-key', GEMINI_API_URL: `${base}/gemini`,
        });

        const root = await createRootStaff(db.pool, { email: 'root@xuanlam.vn', full_name: 'Xuân Lâm' });
        const first = await app.inject({
            method: 'POST', url: '/admin/staff/login', headers: { 'x-admin-key': KEY },
            payload: { email: 'root@xuanlam.vn', password: root.temporary_password },
        });
        rootSession = first.json().session_token;
        const changed = await app.inject({
            method: 'POST', url: '/admin/staff/me/password', headers: { 'x-admin-key': KEY, 'x-staff-session': rootSession },
            payload: { current_password: root.temporary_password, new_password: 'mat-khau-goc-2026' },
        });
        assert.equal(changed.statusCode, 200, changed.body);
    });
    test.after(async () => {
        env.WEATHER_MODE = 'mock';
        await app?.mongo.db.dropDatabase().catch(() => undefined);
        await app?.close();
        await mongo?.close();
        await new Promise(resolve => server?.close(resolve));
        await db?.drop();
    });

    const call = (user: SignedInUser, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) =>
        app.inject({ method, url, headers: user.headers, ...(payload ? { payload } : {}) });
    const admin = (method: 'GET' | 'PUT' | 'DELETE', url: string, payload?: object, session = rootSession) =>
        app.inject({ method, url, headers: { 'x-admin-key': KEY, 'x-staff-session': session }, ...(payload ? { payload } : {}) });
    const row = async (id: string) => (await db.pool.query('SELECT * FROM automations WHERE id = $1', [id])).rows[0];
    const due = (id: string) => db.pool.query(`UPDATE automations SET next_run_at = NOW() - interval '1 minute' WHERE id = $1`, [id]);

    test('the home: a province or one of its areas; an old home reads as its area; removing it clears it', async () => {
        const user = await signUp(app);
        const empty = (await call(user, 'GET', '/weather')).json();
        assert.deepEqual([empty.enabled, empty.location, empty.weather], [true, null, null]);
        const provinces = (await call(user, 'GET', '/weather/provinces')).json().provinces;
        assert.equal(provinces.length, 34);
        assert.equal(provinces.reduce((sum: number, province: any) => sum + province.areas.length, 0), 63);
        assert.deepEqual(provinces.find((province: any) => province.code === 'ho_chi_minh').areas,
            [{ code: 'ho_chi_minh', name: 'TP. Hồ Chí Minh' }, { code: 'binh_duong', name: 'Bình Dương' },
                { code: 'ba_ria_vung_tau', name: 'Bà Rịa – Vũng Tàu' }]);
        assert.equal((await call(user, 'GET', '/weather/places?q=ha')).statusCode, 404, 'no search by ward or commune');

        const set = await call(user, 'PUT', '/me/home-location', { province: 'ha_noi' });
        assert.equal(set.statusCode, 200, set.body);
        assert.deepEqual(set.json().location, { area: 'ha_noi', province: 'ha_noi', place: 'Hà Nội', latitude: 21.03, longitude: 105.85 });
        const weather = (await call(user, 'GET', '/weather')).json();
        assert.equal(weather.location.place, 'Hà Nội');
        assert.equal(weather.weather.current.temperature, 31, 'a sunny mock day by default');
        assert.deepEqual(weather.attribution, { text: 'Thời tiết giả lập (thử nghiệm)', url: null });

        const area = await call(user, 'PUT', '/me/home-location', { area: 'binh_duong' });
        assert.deepEqual(area.json().location, {
            area: 'binh_duong', province: 'ho_chi_minh', place: 'Bình Dương (TP. Hồ Chí Minh)', latitude: 10.98, longitude: 106.65,
        });
        assert.equal((await call(user, 'GET', '/weather')).json().location.area, 'binh_duong');
        assert.equal((await call(user, 'PUT', '/me/home-location', { province: 'lao_cai' })).json().location.area, 'yen_bai',
            'only the province: the area at its centre');
        assert.equal((await call(user, 'PUT', '/me/home-location', { area: 'atlantis' })).json().error.code, 'WEATHER_AREA_UNKNOWN');
        assert.equal((await call(user, 'PUT', '/me/home-location', { province: 'atlantis' })).json().error.code, 'WEATHER_PROVINCE_UNKNOWN');
        assert.equal((await call(user, 'PUT', '/me/home-location', { province: 'ha_noi', area: 'ha_noi' })).statusCode, 400);
        assert.equal((await call(user, 'PUT', '/me/home-location', {
            place: { name: 'Phường Ba Đình', latitude: 21.03, longitude: 105.81 },
        })).statusCode, 400, 'no free place any more');

        // A home saved by ward before the areas existed.
        await db.pool.query(
            `UPDATE account_preferences SET home_latitude = 21.03, home_longitude = 105.81, home_place = 'Phường Ba Đình'
             WHERE account_id = $1`, [user.id],
        );
        assert.equal((await call(user, 'GET', '/weather')).json().location.place, 'Hà Nội');

        assert.equal((await call(user, 'DELETE', '/me/home-location')).statusCode, 200);
        assert.equal((await call(user, 'GET', '/weather')).json().location, null);
        const stored = (await db.pool.query('SELECT home_latitude, home_place FROM account_preferences WHERE account_id = $1', [user.id])).rows[0];
        assert.deepEqual(stored, { home_latitude: null, home_place: null });
    });

    test('a weather condition needs a home; it is checked on the forecast when the automation fires', async () => {
        const owner = await signUp(app);
        const dryMorning = {
            name: 'Nhắc tưới cây', timezone: ZONE, notify_message: 'Hôm nay không mưa, nhớ tưới cây',
            trigger: { kind: 'time', time: '06:00', days: [1, 2, 3, 4, 5, 6, 7] },
            conditions: [{ weather: 'rain_next_12h', operator: 'eq', value: false }],
        };
        assert.equal((await call(owner, 'POST', '/automations', dryMorning)).json().error.code, 'WEATHER_LOCATION_REQUIRED');
        const options = (await call(owner, 'GET', '/automations/options')).json();
        assert.deepEqual([options.weather.place, options.weather.conditions.length], [null, 7]);

        await call(owner, 'PUT', '/me/home-location', { province: 'ha_noi' });
        assert.equal((await call(owner, 'POST', '/automations', {
            ...dryMorning, name: 'Sai', conditions: [{ weather: 'rain_now', operator: 'gt', value: 1 }],
        })).json().error.code, 'AUTOMATION_CONDITION_INVALID');
        assert.equal((await call(owner, 'POST', '/automations', {
            ...dryMorning, name: 'Sai', conditions: [{ weather: 'snow', operator: 'eq', value: true }],
        })).statusCode, 400);
        const created = await call(owner, 'POST', '/automations', dryMorning);
        assert.equal(created.statusCode, 200, created.body);
        const automation = created.json().automation;
        assert.deepEqual(automation.conditions[0], {
            kind: 'weather', device: null, property: 'weather.rain_next_12h', label: 'Có mưa trong 12 giờ tới',
            instance_label: 'Thời tiết', operator: 'eq', value: false, unit: null, available: true,
        });

        try {
            await setMock(app, 'ha_noi', { scenario: 'sunny' });
            await due(automation.id);
            assert.equal(await runDueAutomations(app), 1);
            assert.deepEqual([(await row(automation.id)).last_result, (await row(automation.id)).last_skip_reason], ['notified', null]);

            await setMock(app, 'ha_noi', { scenario: 'raining' });
            await due(automation.id);
            await runDueAutomations(app);
            assert.deepEqual([(await row(automation.id)).last_result, (await row(automation.id)).last_skip_reason], ['skipped_conditions', null]);

            // Live, with no forecast stored: unknown, so not met, and the reason is kept.
            env.WEATHER_MODE = 'live';
            await due(automation.id);
            await runDueAutomations(app);
            assert.deepEqual([(await row(automation.id)).last_result, (await row(automation.id)).last_skip_reason],
                ['skipped_conditions', 'weather_unavailable']);
            env.WEATHER_MODE = 'mock';
            const view = (await call(owner, 'GET', '/automations')).json().automations[0];
            assert.equal(view.last_skip_reason, 'weather_unavailable');

            await setMock(app, 'ha_noi', null);
            await due(automation.id);
            await runDueAutomations(app);
            assert.deepEqual([(await row(automation.id)).last_result, (await row(automation.id)).last_skip_reason], ['notified', null]);

            // Without a home the condition cannot be checked.
            await call(owner, 'DELETE', '/me/home-location');
            assert.equal((await call(owner, 'GET', '/automations')).json().automations[0].conditions[0].available, false);
            await due(automation.id);
            await runDueAutomations(app);
            assert.equal((await row(automation.id)).last_skip_reason, 'weather_unavailable');
        } finally {
            env.WEATHER_MODE = 'mock';
            await setMock(app, 'ha_noi', null);
        }
    });

    test('weather suggestions come with a home and a garden or a roof', async () => {
        const owner = await signUp(app);
        await createOwnedDevice(db.pool, owner.id, { name: 'Vườn', productId: 'prod_irrigation_manager', catalogRevision: 2 });
        await createOwnedDevice(db.pool, owner.id, { name: 'Mái', productId: 'prod_roof_controller', catalogRevision: 2 });
        const templates = async () => (await call(owner, 'GET', '/automations/suggestions')).json().suggestions
            .map((item: any) => item.template);
        assert.ok(!(await templates()).some((name: string) => name.startsWith('weather_')));
        await call(owner, 'PUT', '/me/home-location', { province: 'can_tho' });
        assert.ok((await templates()).includes('weather_water'));
        assert.ok((await templates()).includes('weather_roof'));
        const key = (await call(owner, 'GET', '/automations/suggestions')).json().suggestions
            .find((item: any) => item.template === 'weather_roof').key;
        const applied = await call(owner, 'POST', '/automations/suggestions/apply', { key, timezone: ZONE });
        assert.equal(applied.statusCode, 200, applied.body);
        const automation = applied.json().automation;
        assert.equal(automation.trigger.time, '17:00');
        assert.deepEqual([automation.conditions[0].kind, automation.conditions[0].property, automation.conditions[0].value],
            ['weather', 'weather.rain_next_6h', true]);
        await call(owner, 'DELETE', '/me/home-location');
    });

    test('the Console sets mock weather: simulator.manage, mock mode only, audited', async () => {
        const overview = await admin('GET', '/admin/weather');
        assert.equal(overview.statusCode, 200, overview.body);
        assert.deepEqual([overview.json().mode, overview.json().provinces.length, overview.json().mocks, overview.json().live],
            ['mock', 34, {}, null]);

        const set = await admin('PUT', '/admin/weather/mock', { area: 'ho_chi_minh', scenario: 'rain_soon', rain_in_hours: 3 });
        assert.equal(set.statusCode, 200, set.body);
        assert.deepEqual(set.json().mocks, { ho_chi_minh: { scenario: 'rain_soon', rain_in_hours: 3 } });
        const user = await signUp(app);
        await call(user, 'PUT', '/me/home-location', { area: 'binh_duong' });
        assert.equal((await call(user, 'GET', '/weather')).json().weather.rain_in_hours, 3, 'the mock of the area\'s province');

        assert.equal((await admin('PUT', '/admin/weather/mock', { area: 'atlantis', scenario: 'sunny' })).json().error.code,
            'WEATHER_PROVINCE_UNKNOWN');
        assert.equal((await admin('PUT', '/admin/weather/mock', { area: 'all', scenario: 'snow' })).statusCode, 400);
        assert.equal((await admin('PUT', '/admin/weather/mock', { area: 'all', scenario: 'heat', temperature: 80 })).statusCode, 400);

        const created = (await app.inject({
            method: 'POST', url: '/admin/staff', headers: { 'x-admin-key': KEY, 'x-staff-session': rootSession },
            payload: { email: 'support@xuanlam.vn', full_name: 'Hỗ trợ', permissions: ['accounts.view'] },
        })).json();
        const login = await app.inject({
            method: 'POST', url: '/admin/staff/login', headers: { 'x-admin-key': KEY },
            payload: { email: 'support@xuanlam.vn', password: created.temporary_password },
        });
        const support = login.json().session_token;
        await app.inject({
            method: 'POST', url: '/admin/staff/me/password', headers: { 'x-admin-key': KEY, 'x-staff-session': support },
            payload: { current_password: created.temporary_password, new_password: 'mat-khau-ho-tro' },
        });
        assert.equal((await admin('GET', '/admin/weather', undefined, support)).statusCode, 403);
        assert.equal((await admin('PUT', '/admin/weather/mock', { area: 'all', scenario: 'sunny' }, support)).statusCode, 403);

        try {
            env.WEATHER_MODE = 'live';
            assert.equal((await admin('PUT', '/admin/weather/mock', { area: 'all', scenario: 'sunny' })).json().error.code, 'WEATHER_NOT_MOCK');
        } finally {
            env.WEATHER_MODE = 'mock';
        }
        const cleared = await admin('DELETE', '/admin/weather/mock/ho_chi_minh');
        assert.deepEqual(cleared.json().mocks, {});
        const log = (await db.pool.query(
            `SELECT action, details FROM admin_audit_log WHERE action LIKE 'weather.%' ORDER BY created_at`,
        )).rows;
        assert.deepEqual(log.map(item => item.action), ['weather.mock_set', 'weather.mock_cleared']);
        assert.deepEqual(log[0].details, { area: 'ho_chi_minh', scenario: 'rain_soon', rain_in_hours: 3 });
    });

    test('live forecasts: all 63 areas in 2 requests a round, read from Redis, retried sooner after a failure, within the daily limit', async () => {
        const user = await signUp(app);
        const limit = env.WEATHER_DAILY_CALL_LIMIT;
        const age = async (code: string) => {
            const stored = JSON.parse((await app.redis.get(`weather:area:${code}`))!);
            stored.fetched_at = new Date(Date.now() - 2 * HOUR).toISOString();
            await app.redis.set(`weather:area:${code}`, JSON.stringify(stored));
        };
        /** The next round may start (the lock of the last one is gone). */
        const nextRound = () => app.redis.del('weather:refresh');
        try {
            env.WEATHER_MODE = 'live';
            await call(user, 'PUT', '/me/home-location', { area: 'binh_duong' });
            assert.equal((await call(user, 'GET', '/weather')).json().weather, null, 'before the first round: nothing to read');
            assert.equal(forecastRequests, 0, 'the app never calls Open-Meteo itself');

            assert.equal(await refreshForecasts(app), 63);
            assert.equal(forecastRequests, 2, '50 + 13 areas');
            assert.equal(new Set(forecastCalls).size, 63);
            assert.ok(forecastCalls.includes('10.98,106.65'), 'Bình Dương at Thủ Dầu Một');
            const body = (await call(user, 'GET', '/weather')).json();
            assert.equal(body.weather.current.temperature, 28);
            assert.deepEqual(body.attribution, { text: 'Dữ liệu thời tiết: Open-Meteo.com (CC BY 4.0)', url: 'https://open-meteo.com/' });
            await call(user, 'GET', '/weather');
            assert.equal(await refreshForecasts(app), 0, 'one round per interval');
            await nextRound();
            assert.equal(await refreshForecasts(app), 0, 'nothing is old yet');
            assert.equal(forecastRequests, 2);

            const status = (await admin('GET', '/admin/weather')).json().live;
            assert.deepEqual([status.areas, status.fresh_areas, status.calls_today, status.refresh_minutes], [63, 63, 63, 30]);
            assert.ok(Date.now() - Date.parse(status.refreshed_at) < 60_000);

            // Only the old forecasts are fetched again.
            await age('binh_duong');
            await nextRound();
            assert.equal(await refreshForecasts(app), 1);
            assert.deepEqual([forecastRequests, forecastCalls.at(-1)], [3, '10.98,106.65']);

            // Open-Meteo fails: the round is tried again in 5 minutes, then 10, not after the whole interval.
            failing = true;
            await age('binh_duong');
            await nextRound();
            assert.equal(await refreshForecasts(app), 0);
            let wait = await app.redis.ttl('weather:refresh');
            assert.ok(wait > 0 && wait <= 300, `retry in ${wait} s`);
            assert.equal(await refreshForecasts(app), 0, 'not before then');
            await nextRound();
            await refreshForecasts(app);
            wait = await app.redis.ttl('weather:refresh');
            assert.ok(wait > 300 && wait <= 600, `then in ${wait} s`);
            failing = false;
            await nextRound();
            assert.equal(await refreshForecasts(app), 1);
            assert.equal(await app.redis.get('weather:refresh:failures'), null, 'a good round resets the wait');
            assert.ok(await app.redis.ttl('weather:refresh') > 600);

            const day = new Date(Date.now() + 7 * HOUR).toISOString().slice(0, 10);
            env.WEATHER_DAILY_CALL_LIMIT = Number(await app.redis.get(`weather:calls:${day}`));
            await age('binh_duong');
            await nextRound();
            const before = forecastRequests;
            assert.equal(await refreshForecasts(app), 0);
            assert.equal(forecastRequests, before, 'the daily limit stops the requests');
        } finally {
            env.WEATHER_MODE = 'mock';
            env.WEATHER_DAILY_CALL_LIMIT = limit;
            failing = false;
        }
    });

    test('mock weather for one account: only that account, live or mock, ends by itself, audited', async () => {
        const demo = await signUp(app);
        const other = await signUp(app);
        const rainingNow = {
            name: 'Mưa thì báo', timezone: ZONE, notify_message: 'Trời đang mưa',
            trigger: { kind: 'time', time: '17:00', days: [1, 2, 3, 4, 5, 6, 7] },
            conditions: [{ weather: 'rain_now', operator: 'eq', value: true }],
        };
        const run = async (id: string) => {
            await due(id);
            await runDueAutomations(app);
            return (await row(id)).last_result;
        };
        try {
            env.WEATHER_MODE = 'live';
            await app.redis.set('weather:area:ha_noi', JSON.stringify(liveSnapshot(new Date())));
            for (const user of [demo, other]) await call(user, 'PUT', '/me/home-location', { area: 'ha_noi' });
            const demoRule = (await call(demo, 'POST', '/automations', rainingNow)).json().automation.id;
            const otherRule = (await call(other, 'POST', '/automations', rainingNow)).json().automation.id;
            assert.equal((await admin('PUT', '/admin/weather/mock', { area: 'ha_noi', scenario: 'raining' })).json().error.code,
                'WEATHER_NOT_MOCK', 'live: never a whole province');

            const set = await admin('PUT', '/admin/weather/account-mock', { email: demo.email.toUpperCase(), scenario: 'raining' });
            assert.equal(set.statusCode, 200, set.body);
            assert.equal(set.json().accounts.length, 1);
            const listed = set.json().accounts[0];
            assert.deepEqual([listed.account_id, listed.email, listed.place, listed.scenario], [demo.id, demo.email, 'Hà Nội', 'raining']);
            const left = Date.parse(listed.expires_at) - Date.now();
            assert.ok(left > 119 * 60_000 && left <= 120 * 60_000, `2 hours by default (${left} ms)`);
            const ttl = await app.redis.ttl(`weather:mock:account:${demo.id}`);
            assert.ok(ttl > 7100 && ttl <= 7200, 'Redis drops it by itself');

            const mine = (await call(demo, 'GET', '/weather')).json();
            assert.deepEqual([mine.weather.source, mine.weather.current.raining], ['mock', true]);
            assert.deepEqual(mine.attribution, { text: 'Thời tiết giả lập (thử nghiệm)', url: null });
            const theirs = (await call(other, 'GET', '/weather')).json();
            assert.deepEqual([theirs.weather.source, theirs.weather.current.temperature], ['open-meteo', 30], 'everyone else: the real forecast');
            assert.equal(theirs.attribution.url, 'https://open-meteo.com/');
            assert.equal(await run(demoRule), 'notified', 'the demo account\'s automation sees the rain');
            assert.equal(await run(otherRule), 'skipped_conditions');

            // Set again: replaced, here for 5 hours; a few checks on what is accepted.
            const again = await admin('PUT', '/admin/weather/account-mock', { email: demo.email, scenario: 'heat', hours: 5 });
            assert.equal(again.json().accounts[0].scenario, 'heat');
            assert.ok(Date.parse(again.json().accounts[0].expires_at) - Date.now() > 4.9 * 3_600_000);
            assert.equal((await admin('PUT', '/admin/weather/account-mock', { email: demo.email, scenario: 'heat', hours: 25 })).statusCode, 400);
            assert.equal((await admin('PUT', '/admin/weather/account-mock', { email: demo.email, scenario: 'heat', hours: 0 })).statusCode, 400);
            assert.equal((await admin('PUT', '/admin/weather/account-mock', { email: 'nobody@example.com', scenario: 'heat' })).json().error.code,
                'ACCOUNT_NOT_FOUND');

            // Its time is up: Redis has dropped the mock; the list forgets it too.
            await app.redis.del(`weather:mock:account:${demo.id}`);
            await app.redis.zadd('weather:mock:accounts', Date.now() - 1, demo.id);
            assert.deepEqual((await admin('GET', '/admin/weather')).json().accounts, []);
            assert.equal((await call(demo, 'GET', '/weather')).json().weather.source, 'open-meteo');

            // Mock mode: the account's own mock comes before its province's.
            env.WEATHER_MODE = 'mock';
            await setMock(app, 'ha_noi', { scenario: 'sunny' });
            await admin('PUT', '/admin/weather/account-mock', { email: demo.email, scenario: 'raining' });
            assert.equal((await call(demo, 'GET', '/weather')).json().weather.current.raining, true);
            assert.equal((await call(other, 'GET', '/weather')).json().weather.current.raining, false);

            const cleared = await admin('DELETE', `/admin/weather/account-mock/${demo.id}`);
            assert.deepEqual(cleared.json().accounts, []);
            assert.equal((await call(demo, 'GET', '/weather')).json().weather.current.raining, false);
            assert.equal((await admin('DELETE', `/admin/weather/account-mock/${demo.id}`)).statusCode, 200, 'nothing to end: fine');

            env.WEATHER_MODE = 'off';
            assert.equal((await admin('PUT', '/admin/weather/account-mock', { email: demo.email, scenario: 'heat' })).json().error.code, 'WEATHER_OFF');

            const log = (await db.pool.query(
                `SELECT action, target_account_id, target_email, details FROM admin_audit_log
                 WHERE action LIKE 'weather.account_%' ORDER BY id`,
            )).rows;
            assert.deepEqual(log.map(item => item.action),
                ['weather.account_mock_set', 'weather.account_mock_set', 'weather.account_mock_set', 'weather.account_mock_cleared']);
            assert.deepEqual([log[0].target_account_id, log[0].target_email, log[0].details], [demo.id, demo.email, { scenario: 'raining', hours: 2 }]);
        } finally {
            env.WEATHER_MODE = 'mock';
            await setMock(app, 'ha_noi', null);
            await clearAccountMock(app, demo.id);
            await app.redis.del('weather:area:ha_noi');
        }
    });

    test('the assistant answers weather questions from the forecast, numbers checked', async () => {
        const user = await signUp(app);
        const ask = async (text: string) => {
            const reply = await call(user, 'POST', '/assistant/message', { text });
            assert.equal(reply.statusCode, 200, reply.body);
            return reply.json();
        };
        plan = () => ({ name: 'look_up_weather', args: { when: 'next_hours', amount: 6 } });
        let seen: any[] = [];
        answer = (facts) => {
            seen = facts;
            return 'Bạn chưa đặt vị trí nhà nên mình chưa xem được thời tiết.';
        };
        assert.equal((await ask('lát nữa có mưa không?')).reply, 'Bạn chưa đặt vị trí nhà nên mình chưa xem được thời tiết.');
        assert.equal(seen[0].no_location, true);
        assert.equal(planned.at(-1).weather, null);

        await call(user, 'PUT', '/me/home-location', { province: 'ha_noi' });
        try {
            await setMock(app, 'ha_noi', { scenario: 'rain_soon', rain_in_hours: 2 });
            answer = (facts) => {
                seen = facts;
                return `Theo dự báo, khoảng ${facts[0].rain_hours[0]} trời có thể mưa, khả năng ${facts[0].max_rain_chance}%.`;
            };
            const body = await ask('lát nữa có mưa không?');
            assert.deepEqual(planned.at(-1).weather, { place: 'Hà Nội' });
            assert.equal(body.outcome, 'chat');
            assert.equal(body.reply, `Theo dự báo, khoảng ${seen[0].rain_hours[0]} trời có thể mưa, khả năng 90%.`);
            assert.deepEqual(body.charts, []);
            const turn = (await db.pool.query(
                'SELECT actions FROM assistant_turns WHERE account_id = $1 ORDER BY created_at DESC LIMIT 1', [user.id],
            )).rows[0];
            assert.deepEqual(turn.actions, [{ kind: 'history', what: 'weather', target: null, period: '6 giờ tới', grounded: true }]);

            answer = () => 'Theo dự báo, khả năng mưa là 99%.';
            const invented = await ask('lát nữa có mưa không?');
            assert.match(invented.reply, /^Theo dự báo, 6 giờ tới ở Hà Nội: \d+–\d+°C, có thể mưa khoảng .+ \(khả năng đến 90%\)\.$/);

            // A weather condition drafted by the assistant is saved as one.
            plan = (home) => {
                const weather = home.automation.find((item: any) => item.device === 'Thời tiết ở Hà Nội');
                const dry = weather.watch.find((item: any) => item.what === 'Thời tiết · Có mưa trong 12 giờ tới');
                return {
                    name: 'draft_automation',
                    args: {
                        name: 'Nhắc tưới cây', trigger: 'time', time: '06:00', notify_message: 'Hôm nay không mưa, nhớ tưới cây',
                        conditions: [{ watch_id: dry.id, operator: 'eq', value: 'false' }], quote: 'mỗi sáng 6 giờ',
                    },
                };
            };
            const drafted = await ask('mỗi sáng 6 giờ nếu 12 giờ tới không mưa thì nhắc tôi tưới cây');
            assert.equal(drafted.outcome, 'confirm');
            assert.deepEqual(drafted.draft.conditions, ['Nếu Thời tiết: Không mưa trong 12 giờ tới']);
            const saved = await call(user, 'POST', `/assistant/drafts/${drafted.draft.id}/save`, { timezone: ZONE });
            assert.equal(saved.statusCode, 200, saved.body);
            const stored = await row(saved.json().automation_id);
            assert.deepEqual(stored.conditions, [{ kind: 'weather', weather: 'rain_next_12h', operator: 'eq', value: false }]);
        } finally {
            await setMock(app, 'ha_noi', null);
        }
    });
});
