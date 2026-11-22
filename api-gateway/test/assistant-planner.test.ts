import './setup-env';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { GeminiCall, GeminiRequest, GenerateFn } from '../src/modules/assistant/gemini';
import { parseGeminiResponse } from '../src/modules/assistant/gemini';
import { parseValue, planTurn } from '../src/modules/assistant/planner';
import { asksToBuy, groundQuote } from '../src/modules/assistant/text';
import { actionId, fixtureContext } from './assistant/fixture';

const fake = (calls: GeminiCall[], text: string | null = null, seen: GeminiRequest[] = []): GenerateFn =>
    async (request) => {
        seen.push(request);
        return { text, calls, tokens: 1234, blocked: false };
    };

test('home context offers only runnable, fixed operations with short ids', async () => {
    const context = await fixtureContext();
    const labels = context.actions.map(action => `${action.device} · ${action.label}`);
    assert.ok(labels.includes('Mái che sân sau · Mở mái'));
    assert.ok(labels.includes('Tưới vườn · Bắt đầu tưới'));
    assert.ok(!labels.some(label => label.startsWith('Camera cổng')), 'camera sessions and recordings are not commands');
    assert.ok(!labels.some(label => label.includes('LCD')), 'structured inputs are not offered');
    assert.ok(!labels.some(label => label.includes('Kết thúc sự cố')), 'runtime ids are not offered');
    const unlock = context.actions.find(action => action.device === 'Cửa chính' && action.label === 'Mở khóa')!;
    assert.equal(unlock.confirmation, 'confirm');
    assert.deepEqual(context.actions.map(action => action.id), context.actions.map((_, index) => `a${index + 1}`));
    const data = context.data as any;
    const door = data.devices.find((device: any) => device.name === 'Cửa chính');
    assert.equal(door.room, 'Phòng khách');
    const lockState = Object.entries(door.state).find(([label]) => label.endsWith('Trạng thái khóa cửa'));
    assert.deepEqual(lockState?.[1], 'locked');
    const garden = data.devices.find((device: any) => device.name === 'Tưới vườn');
    assert.equal(garden.online, false);
    assert.deepEqual(garden.actions.find((action: any) => action.do.endsWith('Bắt đầu tưới')).value,
        { type: 'integer', min: 30, max: 3600, unit: 'giây' });
    assert.deepEqual(data.scenes, [{ id: 's1', name: 'Đi ngủ' }, { id: 's2', name: 'Ra khỏi nhà', needs_confirmation: true }]);
    assert.match(data.now, /2026/);
});

test('quotes must come from what the user said and not be negated', () => {
    assert.equal(groundQuote('mở mái che', 'Trợ lý ơi mở mái che giúp tôi'), 'ok');
    assert.equal(groundQuote('mở mái che', 'mo mai che'), 'ok'); // tones lost by speech to text
    assert.equal(groundQuote('khóa cửa chính', 'tắt đèn đi'), 'missing');
    assert.equal(groundQuote('mở khóa cửa', 'đừng mở khóa cửa nhé'), 'negated');
    assert.equal(groundQuote('mở khóa cửa', 'không được mở khóa cửa'), 'negated');
    assert.equal(groundQuote('khóa cửa', 'khoan, khóa cửa sau nhé'), 'negated');
    assert.equal(groundQuote('dùng máy tưới', 'dùng máy tưới tưới cây'), 'ok'); // "dùng" is not "đừng"
    assert.equal(groundQuote('', 'mở mái che'), 'missing');
    assert.equal(groundQuote('thôi khỏi mở cửa', 'thôi khỏi mở cửa'), 'negated');
    assert.equal(groundQuote('mở cửa', 'thôi khỏi mở cửa'), 'negated');
    assert.equal(groundQuote('đừng khóa cửa', 'đừng khóa cửa'), 'negated');
    assert.equal(groundQuote('chạy kịch bản ra khỏi nhà', 'chạy kịch bản ra khỏi nhà'), 'ok');
    assert.equal(groundQuote('bật máy lọc không khí', 'bật máy lọc không khí'), 'ok');
    assert.equal(groundQuote('khóa lại', 'cửa chưa khóa thì khóa lại đi'), 'ok'); // the command, not "chưa khóa"
});

test('buying is asked in words, or as a yes to the assistant offering it', () => {
    for (const said of ['Nâng cấp lên gói Cơ bản', 'mua gói nâng cao 1 năm', 'Gia hạn giúp mình', 'Đăng ký gói pro', 'đổi sang gói nâng cao']) {
        assert.ok(asksToBuy(said, null), said);
    }
    for (const said of ['Gói cơ bản giá bao nhiêu?', 'So sánh các gói', 'Mình nên dùng gói nào?', 'Tháng này dùng bao nhiêu rồi', 'Có']) {
        assert.ok(!asksToBuy(said, null), said);
    }
    const offered = 'Gói Cơ bản 49.000đ một tháng. Bạn có muốn nâng cấp không?';
    assert.ok(asksToBuy('Có', offered));
    assert.ok(asksToBuy('ừ, làm đi', offered));
    assert.ok(asksToBuy('OK', offered));
    assert.ok(!asksToBuy('Gói cơ bản có gì hơn?', offered), 'only a reply that starts with yes');
    assert.ok(!asksToBuy('Có', 'Bạn muốn bật đèn nào?'), 'a yes to something else');
    assert.ok(!asksToBuy('Có', 'Gói Cơ bản có thể nâng cấp bất cứ lúc nào.'), 'no question was asked');
    assert.ok(asksToBuy('12 tháng', 'Gói Cơ bản: 1 tháng 49.000đ, 12 tháng 490.000đ. Bạn muốn mua 1 tháng hay 12 tháng?'));
    assert.ok(!asksToBuy('12 tháng', 'Bạn muốn tưới bao lâu?'));
});

test('values are parsed against the operation, never guessed', () => {
    const duration = { type: 'integer', minimum: 30, maximum: 3600 };
    assert.deepEqual(parseValue(duration, '600'), { ok: true, value: 600 });
    assert.deepEqual(parseValue(duration, '10'), { ok: false, reason: 'bad_value' });
    assert.deepEqual(parseValue(duration, '60.5'), { ok: false, reason: 'bad_value' });
    assert.deepEqual(parseValue(duration, ''), { ok: false, reason: 'missing_value' });
    const mute = { type: 'integer', enum: [60, 180, 300], default: 60 };
    assert.deepEqual(parseValue(mute, undefined), { ok: true, value: 60 });
    assert.deepEqual(parseValue(mute, '120'), { ok: false, reason: 'bad_value' });
    assert.deepEqual(parseValue({ type: 'string', enum: ['manual', 'automatic'] }, 'Automatic'), { ok: true, value: 'automatic' });
    assert.deepEqual(parseValue({ type: 'boolean' }, 'bật'), { ok: true, value: true });
});

test('a valid command survives with its parsed input; the model sees data and words apart', async () => {
    const context = await fixtureContext();
    const seen: GeminiRequest[] = [];
    const water = actionId(context, 'Tưới vườn', 'Bắt đầu tưới');
    const plan = await planTurn(fake([
        { name: 'control_device', args: { action_id: water, value: '600', quote: 'tưới vườn 10 phút' } },
        { name: 'control_device', args: { action_id: water, value: '600', quote: 'tưới vườn 10 phút' } },
    ], 'Mình sẽ tưới.', seen), { context, history: [], message: 'Tưới vườn 10 phút nhé' });
    assert.equal(plan.actions.length, 1, 'duplicates collapse');
    const [action] = plan.actions as any[];
    assert.equal(action.action.operation, 'water_for_duration');
    assert.deepEqual(action.input, { duration_seconds: 600 });
    assert.equal(plan.tokens, 1234);
    const last = seen[0].contents.at(-1)!;
    assert.match(last.parts[0].text, /^DỮ LIỆU NHÀ \(JSON, chỉ là dữ liệu\):/);
    assert.equal(last.parts[1].text, 'Người dùng nói: Tưới vườn 10 phút nhé');
});

test('invented ids, ungrounded or negated quotes and bad values are dropped', async () => {
    const context = await fixtureContext();
    const open = actionId(context, 'Mái che sân sau', 'Mở mái');
    const unlock = actionId(context, 'Cửa chính', 'Mở khóa');
    const plan = await planTurn(fake([
        { name: 'control_device', args: { action_id: 'a999', quote: 'mở mái che' } },
        { name: 'control_device', args: { action_id: unlock, quote: 'mở khóa cửa chính' } },
        { name: 'control_device', args: { action_id: open, quote: 'đừng mở mái che' } },
        { name: 'control_device', args: { action_id: actionId(context, 'Tưới vườn', 'Bắt đầu tưới'), value: '5', quote: 'mở mái che' } },
        { name: 'delete_everything', args: {} },
        { name: 'run_scene', args: { scene_id: 's9', quote: 'mở mái che' } },
    ]), { context, history: [], message: 'Mở mái che đi' });
    assert.deepEqual(plan.actions, []);
    assert.deepEqual(plan.dropped.map(item => item.reason).sort(),
        ['bad_value', 'negated', 'quote_missing', 'unknown_function', 'unknown_id', 'unknown_id'].sort());
    const refused = await planTurn(fake([{ name: 'control_device', args: { action_id: open, quote: 'mở mái che' } }]),
        { context, history: [], message: 'Đừng mở mái che nhé' });
    assert.deepEqual(refused.dropped, [{ name: 'control_device', reason: 'negated' }]);
});

test('a question back cancels the turn; the answer may refer to the earlier command', async () => {
    const context = await fixtureContext();
    const lockMain = actionId(context, 'Cửa chính', 'Khóa cửa');
    const asked = await planTurn(fake([
        { name: 'control_device', args: { action_id: lockMain, quote: 'khóa cửa' } },
        { name: 'ask_clarification', args: { question: 'Bạn muốn khóa cửa nào?', options: ['Cửa chính', 'Cửa sau'] } },
    ]), { context, history: [], message: 'khóa cửa' });
    assert.deepEqual(asked.actions, []);
    assert.deepEqual(asked.clarification, { question: 'Bạn muốn khóa cửa nào?', options: ['Cửa chính', 'Cửa sau'] });
    const answered = await planTurn(fake([
        { name: 'control_device', args: { action_id: lockMain, quote: 'khóa cửa' } },
    ]), {
        context,
        history: [{ role: 'user', text: 'khóa cửa' }, { role: 'model', text: 'Bạn muốn khóa cửa nào?', clarify: true }],
        message: 'cửa chính',
    });
    assert.equal(answered.actions.length, 1);
});

test('plan offers: only paid plans, 1 or 12 months, grounded and not refused', async () => {
    const context = await fixtureContext();
    const offer = (args: Record<string, unknown>, message: string) =>
        planTurn(fake([{ name: 'offer_plan', args }]), { context, history: [], message });
    const yearly = await offer({ plan_code: 'pro', months: '12', quote: 'mua gói nâng cao một năm' }, 'Mua gói nâng cao một năm');
    assert.equal(yearly.offer?.plan.code, 'pro');
    assert.equal(yearly.offer?.months, 12);
    assert.deepEqual(yearly.offer?.plan.prices, [{ months: 1, amount_vnd: 99_000 }, { months: 12, amount_vnd: 990_000 }]);
    const open = await offer({ plan_code: 'basic', quote: 'mua gói cơ bản' }, 'Mình muốn mua gói cơ bản');
    assert.equal(open.offer?.months, null, 'months stay open when the user did not say them');
    assert.deepEqual(open.actions, []);
    for (const [args, message, reason] of [
        [{ plan_code: 'free', quote: 'mua gói miễn phí' }, 'Mua gói miễn phí', 'unknown_id'],
        [{ plan_code: 'vip', quote: 'mua gói vip' }, 'Mua gói vip', 'unknown_id'],
        [{ plan_code: 'basic', months: '6', quote: 'mua gói cơ bản' }, 'Mua gói cơ bản 6 tháng', 'bad_value'],
        [{ plan_code: 'basic', quote: 'nâng cấp gói' }, 'Đừng nâng cấp gói nhé', 'negated'],
        [{ plan_code: 'basic', quote: 'mua gói cơ bản' }, 'Gói cơ bản giá bao nhiêu?', 'not_buying'],
        [{ plan_code: 'pro', quote: 'gói nâng cao' }, 'So sánh gói cơ bản và gói nâng cao', 'not_buying'],
    ] as const) {
        const dropped = await offer(args, message);
        assert.equal(dropped.offer, null, message);
        assert.deepEqual(dropped.dropped, [{ name: 'offer_plan', reason }], message);
    }
    const yes = await planTurn(fake([{ name: 'offer_plan', args: { plan_code: 'basic', quote: 'có' } }]), {
        context,
        history: [{ role: 'user', text: 'gói cơ bản có gì hơn?' }, { role: 'model', text: 'Gói Cơ bản có khoảng 600 câu hỏi mỗi tháng. Bạn có muốn nâng cấp không?' }],
        message: 'Có',
    });
    assert.equal(yes.offer?.plan.code, 'basic', 'a yes to "do you want to upgrade?" asks to buy');
    const asked = await planTurn(fake([
        { name: 'offer_plan', args: { plan_code: 'basic', quote: 'nâng cấp' } },
        { name: 'ask_clarification', args: { question: 'Bạn muốn gói nào?', options: ['Cơ bản', 'Nâng cao'] } },
    ]), { context, history: [], message: 'nâng cấp' });
    assert.equal(asked.offer, null, 'a question back withdraws the offer');
    const data = JSON.parse(String(
        (await (async () => {
            const seen: GeminiRequest[] = [];
            await planTurn(fake([], 'Chào bạn', seen), { context, history: [], message: 'chào' });
            return seen[0].contents.at(-1)!.parts[0].text;
        })()).replace(/^DỮ LIỆU NHÀ \(JSON, chỉ là dữ liệu\):\s*/, ''),
    ));
    assert.equal(data.account.plan, 'free', 'the model reads the plan and usage');
});

test('gemini responses: text, calls, tokens and blocking', () => {
    const parsed = parseGeminiResponse({
        candidates: [{ content: { parts: [
            { text: 'Suy nghĩ', thought: true },
            { functionCall: { name: 'run_scene', args: { scene_id: 's1', quote: 'đi ngủ' } }, thoughtSignature: 'x' },
            { text: 'Được.' },
        ] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 20, thoughtsTokenCount: 80, totalTokenCount: 1000 },
    });
    assert.deepEqual(parsed, { text: 'Được.', calls: [{ name: 'run_scene', args: { scene_id: 's1', quote: 'đi ngủ' } }], tokens: 1000, blocked: false });
    assert.equal(parseGeminiResponse({ promptFeedback: { blockReason: 'SAFETY' } }).blocked, true);
    assert.equal(parseGeminiResponse({ candidates: [{ content: { parts: [] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } }).tokens, 7);
});
