import './setup-env';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseValue, type Plan } from '../src/modules/assistant/planner';
import { WEATHER_CONDITION_IDS } from '../src/modules/weather/forecast';
import { WEATHER_WHENS } from '../src/modules/assistant/weatherLookup';
import { fixtureContext } from './assistant/fixture';
import { type AssistantCase, scoreCase } from './assistant/score';

const cases: AssistantCase[] = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'assistant', 'cases.json'), 'utf8'),
).cases;

test('the prompt test set has about 140 sentences, each valid for the sample home', async () => {
    const context = await fixtureContext();
    assert.ok(cases.length >= 140);
    assert.deepEqual(cases.map(item => item.id), cases.map((_, index) => index + 1));
    for (const item of cases) {
        assert.ok(['act', 'ask', 'none', 'allow', 'offer', 'draft', 'history', 'weather'].includes(item.expect), `case ${item.id}`);
        if (item.expect === 'history') assert.ok(item.lookups?.length, `case ${item.id}: history needs lookups`);
        if (item.expect === 'weather') assert.ok(item.weather?.length, `case ${item.id}: weather needs forecasts`);
        for (const lookup of item.weather ?? []) {
            assert.ok(lookup.when.every(when => (WEATHER_WHENS as readonly string[]).includes(when)), `case ${item.id}`);
        }
        for (const condition of item.draft?.weather ?? []) {
            for (const choice of condition.split('|')) {
                const match = /^([a-z0-9_]+)(=|>|<)(.+)$/.exec(choice);
                assert.ok(match && WEATHER_CONDITION_IDS.includes(match[1] as any), `case ${item.id}: ${choice}`);
            }
        }
        for (const lookup of item.lookups ?? []) {
            assert.ok(lookup.what.every(what => ['events', 'readings', 'commands', 'runs'].includes(what)), `case ${item.id}`);
            if (lookup.device) assert.ok(context.history.some(device => device.device === lookup.device), `case ${item.id}: ${lookup.device}`);
            if (lookup.run) {
                assert.ok([...context.scenes, ...context.automations].some(entry => entry.name === lookup.run), `case ${item.id}: ${lookup.run}`);
            }
        }
        assert.equal(item.expect === 'draft', item.draft !== undefined, `case ${item.id}: draft goes with expect "draft"`);
        if (item.expect === 'act') assert.ok((item.actions?.length ?? 0) + (item.scenes?.length ?? 0) > 0, `case ${item.id}`);
        assert.equal(item.expect === 'offer', item.offer !== undefined, `case ${item.id}: offer goes with expect "offer"`);
        if (item.offer) {
            const offered = context.plans.find(plan => plan.code === item.offer!.plan);
            assert.ok(offered, `case ${item.id}: plan ${item.offer.plan} cannot be bought`);
            assert.ok(item.offer.months === null || offered.prices.some(price => price.months === item.offer!.months), `case ${item.id}`);
        }
        for (const expected of [...(item.actions ?? []), ...(item.draft?.steps ?? [])]) {
            const action = context.actions.find(entry => entry.device === expected.device && entry.label === expected.label);
            assert.ok(action, `case ${item.id}: no "${expected.label}" on "${expected.device}"`);
            if (action.input) {
                const parsed = parseValue(action.input.schema, expected.value);
                assert.ok(parsed.ok, `case ${item.id}: bad value ${expected.value}`);
            } else {
                assert.equal(expected.value, undefined, `case ${item.id}: "${expected.label}" takes no value`);
            }
        }
        for (const scene of item.scenes ?? []) {
            assert.ok(context.scenes.some(entry => entry.name === scene), `case ${item.id}: no scene ${scene}`);
        }
    }
});

test('scoring: anything run that was not expected is a wrong command', async () => {
    const context = await fixtureContext();
    const close = context.actions.find(action => action.device === 'Mái che sân sau' && action.label === 'Đóng mái')!;
    const plan = (actions: Plan['actions'], extra: Partial<Plan> = {}): Plan =>
        ({
            text: null, actions, clarification: null, offer: null, draft: null, lookups: [], weather: [], dropped: [], tokens: 0,
            blocked: false, ...extra,
        });
    const closing = plan([{ kind: 'device', action: close, input: {}, quote: 'đóng mái' }]);
    const act: AssistantCase = { id: 1, say: 'đóng mái che', expect: 'act', actions: [{ device: 'Mái che sân sau', label: 'Đóng mái' }] };
    assert.equal(scoreCase(act, closing), 'pass');
    assert.equal(scoreCase(act, plan([])), 'missed');
    assert.equal(scoreCase({ id: 2, say: 'x', expect: 'none' }, closing), 'wrong_command');
    assert.equal(scoreCase({ id: 3, say: 'x', expect: 'ask' }, plan([], { text: 'Bạn muốn tắt gì?' })), 'pass');
    assert.equal(scoreCase({ id: 4, say: 'x', expect: 'ask' }, plan([], { text: 'Được.' })), 'not_asked');
    assert.equal(scoreCase({ id: 5, say: 'x', expect: 'allow', actions: [] }, closing), 'wrong_command');

    const basic = context.plans.find(item => item.code === 'basic')!;
    const offering = (months: 1 | 12 | null) => plan([], { offer: { plan: basic, months } });
    const buy: AssistantCase = { id: 6, say: 'mua gói cơ bản 1 tháng', expect: 'offer', offer: { plan: 'basic', months: 1 } };
    assert.equal(scoreCase(buy, offering(1)), 'pass');
    assert.equal(scoreCase(buy, offering(12)), 'wrong_offer');
    assert.equal(scoreCase(buy, offering(null)), 'wrong_offer');
    assert.equal(scoreCase(buy, plan([])), 'missed');
    assert.equal(scoreCase(buy, plan(closing.actions, { offer: { plan: basic, months: 1 } })), 'wrong_command');
    assert.equal(scoreCase({ id: 7, say: 'gói cơ bản giá bao nhiêu', expect: 'none' }, offering(null)), 'wrong_offer');

    const water = context.actions.find(action => action.device === 'Tưới vườn' && action.label === 'Bắt đầu tưới')!;
    const drafted = (time: string, seconds: number) => plan([], {
        draft: {
            name: 'Tưới sáng', icon: 'water', trigger: { kind: 'time', time, days: [1, 2, 3, 4, 5, 6, 7] }, conditions: [],
            window: null, steps: [{ action: water, input: { duration_seconds: seconds }, delay_seconds: 0 }], notify_message: null,
        },
    });
    const morning: AssistantCase = {
        id: 8, say: 'mỗi sáng 6 giờ tưới vườn 10 phút', expect: 'draft',
        draft: { trigger: 'time', time: '06:00', steps: [{ device: 'Tưới vườn', label: 'Bắt đầu tưới', value: 600 }] },
    };
    assert.equal(scoreCase(morning, drafted('06:00', 600)), 'pass');
    assert.equal(scoreCase(morning, drafted('18:00', 600)), 'wrong_draft');
    assert.equal(scoreCase(morning, drafted('06:00', 300)), 'wrong_draft');
    assert.equal(scoreCase(morning, plan([])), 'missed');
    assert.equal(scoreCase({ id: 9, say: 'có hẹn giờ được không', expect: 'none' }, drafted('06:00', 600)), 'wrong_draft');

    const door = context.history.find(item => item.device === 'Cửa chính')!;
    const looked = (what: 'events' | 'commands', period: string) => plan([], {
        lookups: [{ what, device: door, window: { start: new Date(0), end: new Date(1), label: period, days: 1, clipped: false, too_old: false } }] as Plan['lookups'],
    });
    const asked: AssistantCase = {
        id: 10, say: 'hôm qua cửa chính mở mấy lần', expect: 'history', lookups: [{ what: ['events'], device: 'Cửa chính', period: 'hôm qua' }],
    };
    assert.equal(scoreCase(asked, looked('events', 'hôm qua (20/11)')), 'pass');
    assert.equal(scoreCase(asked, looked('commands', 'hôm qua (20/11)')), 'wrong_history');
    assert.equal(scoreCase(asked, looked('events', 'hôm nay (21/11)')), 'wrong_history');
    assert.equal(scoreCase(asked, plan([])), 'missed');
    assert.equal(scoreCase(asked, closing), 'wrong_command');
    assert.equal(scoreCase({ id: 11, say: 'cửa đang khóa không', expect: 'none' }, looked('events', 'hôm nay')), 'wrong_history');
});

test('the sample account sees its plan, usage and prices; only paid plans can be offered', async () => {
    const context = await fixtureContext();
    const account = context.data.account as any;
    assert.equal(account.plan, 'free');
    assert.equal(account.used_tokens_this_month, 82_000);
    assert.equal(account.resets_on, '2026-12-01');
    assert.equal(account.payments, true);
    assert.deepEqual(account.plans.map((item: any) => [item.code, item.price_1_month_vnd, item.price_12_months_vnd, item.about_questions_per_month]),
        [['free', 0, null, 40], ['basic', 49_000, 490_000, 600], ['pro', 99_000, 990_000, 2000]]);
    assert.deepEqual(context.plans.map(item => item.code), ['basic', 'pro']);
});
