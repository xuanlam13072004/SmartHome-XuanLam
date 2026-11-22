/**
 * Runs the assistant prompt test set (test/assistant/cases.json) against the
 * real Gemini model, through the same planner and checks as the service,
 * on the sample home. Nothing is sent to any device.
 *
 *   GEMINI_API_KEY=... npx tsx scripts/assistant-eval.ts [--delay 4000] [--only 1,5,9] [--out report.json]
 *
 * Exit code 1 when any sentence would run a wrong command. A wrong plan offer or
 * draft is counted too, but does not fail the run: the user still has to confirm it.
 */
import '../test/setup-env';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../src/config/env';
import { geminiGenerate, type GenerateFn } from '../src/modules/assistant/gemini';
import { planTurn } from '../src/modules/assistant/planner';
import { fixtureContext } from '../test/assistant/fixture';
import { type AssistantCase, draftKeys, planKeys, scoreCase, type Verdict } from '../test/assistant/score';

function option(name: string): string | undefined {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
    if (!env.GEMINI_API_KEY) throw new Error('Set GEMINI_API_KEY');
    const delay = Number(option('delay') ?? 4000);
    const only = option('only')?.split(',').map(Number);
    const all: AssistantCase[] = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test', 'assistant', 'cases.json'), 'utf8')).cases;
    const cases = only ? all.filter(item => only.includes(item.id)) : all;
    const context = await fixtureContext();
    const gemini = geminiGenerate({ warn: (obj, msg) => console.warn(msg, obj) });
    const rows: Array<Record<string, unknown>> = [];
    const counts: Record<Verdict, number> = { pass: 0, wrong_command: 0, missed: 0, not_asked: 0, wrong_offer: 0, wrong_draft: 0 };
    let tokens = 0;
    let proposedButDropped = 0;
    console.log(`Model ${env.GEMINI_MODEL} (thinking ${env.GEMINI_THINKING_LEVEL || 'default'}), ${cases.length} sentences`);
    for (const item of cases) {
        let raw: string[] = [];
        const recorder: GenerateFn = async (request) => {
            const result = await gemini(request);
            raw = result.calls.map(call => `${call.name}(${JSON.stringify(call.args)})`);
            return result;
        };
        const started = Date.now();
        try {
            const plan = await planTurn(recorder, { context, history: item.history ?? [], message: item.say });
            const verdict = scoreCase(item, plan);
            counts[verdict] += 1;
            tokens += plan.tokens;
            proposedButDropped += plan.dropped.length;
            const offered = plan.offer ? `offer ${plan.offer.plan.code}/${plan.offer.months ?? '?'}`
                : plan.draft ? `draft ${plan.draft.trigger?.kind ?? 'none'}${plan.draft.trigger?.kind === 'time' ? ` ${plan.draft.trigger.time} [${plan.draft.trigger.days}]` : ''}: ${draftKeys(plan).join(', ')}${plan.draft.notify_message ? ' +notify' : ''}`
                    : null;
            rows.push({ id: item.id, say: item.say, expect: item.expect, verdict, ran: planKeys(plan), offered, model_calls: raw,
                dropped: plan.dropped, question: plan.clarification?.question, reply: plan.text, tokens: plan.tokens,
                ms: Date.now() - started });
            const mark = verdict === 'pass' ? 'ok ' : verdict === 'wrong_command' ? 'SAI' : '-- ';
            const shown = [...planKeys(plan), ...(offered ? [offered] : [])].join(', ')
                || plan.clarification?.question || (plan.text ?? '').slice(0, 60);
            console.log(`${mark} #${item.id} [${item.expect}] ${item.say} → ${shown}`);
        } catch (error: any) {
            rows.push({ id: item.id, say: item.say, error: error?.code ?? String(error) });
            console.log(`ERR #${item.id} ${item.say}: ${error?.code ?? error}`);
        }
        await new Promise(resolve => setTimeout(resolve, delay));
    }
    const summary = { model: env.GEMINI_MODEL, sentences: cases.length, ...counts, tokens, dropped_by_checks: proposedButDropped };
    console.log('\nKết quả:', JSON.stringify(summary));
    const out = option('out');
    if (out) fs.writeFileSync(out, JSON.stringify({ summary, rows }, null, 2));
    process.exitCode = counts.wrong_command > 0 ? 1 : 0;
}

main().catch(error => {
    console.error(error);
    process.exitCode = 2;
});
