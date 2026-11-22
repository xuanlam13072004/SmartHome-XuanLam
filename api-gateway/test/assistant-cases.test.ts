import './setup-env';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseValue, type Plan } from '../src/modules/assistant/planner';
import { fixtureContext } from './assistant/fixture';
import { type AssistantCase, scoreCase } from './assistant/score';

const cases: AssistantCase[] = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'assistant', 'cases.json'), 'utf8'),
).cases;

test('the prompt test set has about 100 sentences, each valid for the sample home', async () => {
    const context = await fixtureContext();
    assert.ok(cases.length >= 100);
    assert.deepEqual(cases.map(item => item.id), cases.map((_, index) => index + 1));
    for (const item of cases) {
        assert.ok(['act', 'ask', 'none', 'allow'].includes(item.expect), `case ${item.id}`);
        if (item.expect === 'act') assert.ok((item.actions?.length ?? 0) + (item.scenes?.length ?? 0) > 0, `case ${item.id}`);
        for (const expected of item.actions ?? []) {
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
        ({ text: null, actions, clarification: null, dropped: [], tokens: 0, blocked: false, ...extra });
    const closing = plan([{ kind: 'device', action: close, input: {}, quote: 'đóng mái' }]);
    const act: AssistantCase = { id: 1, say: 'đóng mái che', expect: 'act', actions: [{ device: 'Mái che sân sau', label: 'Đóng mái' }] };
    assert.equal(scoreCase(act, closing), 'pass');
    assert.equal(scoreCase(act, plan([])), 'missed');
    assert.equal(scoreCase({ id: 2, say: 'x', expect: 'none' }, closing), 'wrong_command');
    assert.equal(scoreCase({ id: 3, say: 'x', expect: 'ask' }, plan([], { text: 'Bạn muốn tắt gì?' })), 'pass');
    assert.equal(scoreCase({ id: 4, say: 'x', expect: 'ask' }, plan([], { text: 'Được.' })), 'not_asked');
    assert.equal(scoreCase({ id: 5, say: 'x', expect: 'allow', actions: [] }, closing), 'wrong_command');
});
