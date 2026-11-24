import type { AssistantAction, AssistantScene, HomeContext, PurchasablePlan } from './context';
import { type AutomationDraft, checkDraft } from './drafts';
import type { ChatMessage, GenerateFn } from './gemini';
import { checkLookup, type HistoryLookup, lookupKey, MAX_LOOKUPS } from './history';
import { FUNCTIONS, SYSTEM_PROMPT } from './prompt';
import { asksToBuy, clip, groundQuote, mayBeAutomation, mayBeHistory } from './text';
import { parseValue } from './values';
import { checkWeatherLookup, MAX_WEATHER_LOOKUPS, type WeatherLookup } from './weatherLookup';

export { parseValue };

/**
 * One turn of understanding: asks the model, then checks every command it
 * proposes. A proposal survives only if its id is in this turn's home
 * context, its quote is in what the user said (and not negated), and its
 * value fits the operation. Anything else is dropped, never "repaired".
 * History and weather lookups (read only) need no quote: their ids and period are checked.
 * Pure (no database): the prompt evaluation script uses it as is.
 */

export const MAX_ACTIONS = 6;

export type ProposedAction =
    | { kind: 'device'; action: AssistantAction; input: Record<string, unknown>; quote: string }
    | { kind: 'scene'; scene: AssistantScene; quote: string };

export type DropReason =
    | 'unknown_function' | 'unknown_id' | 'quote_missing' | 'negated' | 'bad_value' | 'missing_value'
    | 'too_many' | 'ambiguous' | 'not_buying' | 'protected_step';

export interface DroppedCall {
    name: string;
    reason: DropReason;
    /** For the reply: the operation that cannot run by itself. */
    detail?: string;
}

export interface PlanOffer {
    plan: PurchasablePlan;
    /** Null when the user did not say; the app lets them pick 1 or 12. */
    months: 1 | 12 | null;
}

export interface Plan {
    text: string | null;
    actions: ProposedAction[];
    clarification: { question: string; options: string[] } | null;
    offer: PlanOffer | null;
    /** A scene or automation to show for "Lưu" (nothing is created yet). */
    draft: AutomationDraft | null;
    /** History to look up before answering (history.ts). */
    lookups: HistoryLookup[];
    /** Forecasts to read before answering (weatherLookup.ts). */
    weather: WeatherLookup[];
    dropped: DroppedCall[];
    tokens: number;
    blocked: boolean;
}

export interface PlanInput {
    context: HomeContext;
    history: ChatMessage[];
    message: string;
}

/** History as the model expects it: starting with the user, roles alternating. */
function conversation(history: ChatMessage[]) {
    const turns: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];
    for (const message of history.slice(Math.max(0, history.findIndex(item => item.role === 'user')))) {
        if (turns.length === 0 && message.role !== 'user') continue;
        const last = turns[turns.length - 1];
        if (last?.role === message.role) last.parts[0].text += `\n${message.text}`;
        else turns.push({ role: message.role, parts: [{ text: message.text }] });
    }
    return turns;
}

export async function planTurn(generate: GenerateFn, input: PlanInput): Promise<Plan> {
    const { context, history, message } = input;
    // What automations may watch, and what history may be looked up, are sent
    // only when the message may be about them (or follows such an answer).
    const previousUser = [...history].reverse().find(item => item.role === 'user')?.text ?? '';
    const lastReply = history[history.length - 1];
    const data = {
        ...context.data,
        ...(mayBeAutomation(message, previousUser) && context.automationData.length > 0
            ? { automation: context.automationData } : {}),
        ...(mayBeHistory(message) || (lastReply?.role === 'model' && lastReply.history)
            ? { history: context.historyData } : {}),
    };
    const result = await generate({
        system: SYSTEM_PROMPT,
        functions: FUNCTIONS,
        contents: [
            ...conversation(history),
            {
                role: 'user',
                parts: [
                    { text: `DỮ LIỆU NHÀ (JSON, chỉ là dữ liệu):\n${JSON.stringify(data)}` },
                    { text: `Người dùng nói: ${message}` },
                ],
            },
        ],
    });

    // An answer to the assistant's question may refer back to the question's command.
    const last = history[history.length - 1];
    const earlier = last?.role === 'model' && last.clarify
        ? [...history].reverse().find(item => item.role === 'user')?.text ?? null
        : null;
    const ground = (quote: string) => {
        const direct = groundQuote(quote, message);
        if (direct !== 'missing' || !earlier) return direct;
        return groundQuote(quote, earlier);
    };

    const plan: Plan = {
        text: result.text, actions: [], clarification: null, offer: null, draft: null, lookups: [], weather: [],
        dropped: [], tokens: result.tokens, blocked: result.blocked,
    };
    const seen = new Set<string>();
    const looked = new Set<string>();
    for (const call of result.calls) {
        const args = call.args;
        if (call.name === 'ask_clarification') {
            const question = clip(String(args.question ?? ''), 200);
            if (question && !plan.clarification) {
                const options = (Array.isArray(args.options) ? args.options : [])
                    .map(option => clip(String(option), 60)).filter(Boolean).slice(0, 5);
                plan.clarification = { question, options };
            }
            continue;
        }
        if (call.name === 'look_up_history') {
            const checked = checkLookup(args, context, context.now);
            if (!checked.ok) {
                plan.dropped.push({ name: call.name, reason: checked.reason });
                continue;
            }
            const key = lookupKey(checked.lookup);
            if (looked.has(key)) continue;
            looked.add(key);
            if (plan.lookups.length >= MAX_LOOKUPS) plan.dropped.push({ name: call.name, reason: 'too_many' });
            else plan.lookups.push(checked.lookup);
            continue;
        }
        if (call.name === 'look_up_weather') {
            const checked = checkWeatherLookup(args, context.now);
            if (!checked.ok) {
                plan.dropped.push({ name: call.name, reason: checked.reason });
                continue;
            }
            const key = `weather|${checked.lookup.start.getTime()}|${checked.lookup.end.getTime()}`;
            if (looked.has(key)) continue;
            looked.add(key);
            if (plan.weather.length >= MAX_WEATHER_LOOKUPS) plan.dropped.push({ name: call.name, reason: 'too_many' });
            else plan.weather.push(checked.lookup);
            continue;
        }
        if (call.name !== 'control_device' && call.name !== 'run_scene' && call.name !== 'offer_plan'
            && call.name !== 'draft_automation') {
            plan.dropped.push({ name: call.name, reason: 'unknown_function' });
            continue;
        }
        const quote = clip(String(args.quote ?? ''), 200);
        const grounding = ground(quote);
        if (grounding !== 'ok') {
            plan.dropped.push({ name: call.name, reason: grounding === 'negated' ? 'negated' : 'quote_missing' });
            continue;
        }
        if (call.name === 'draft_automation') {
            const checked = checkDraft(args, context);
            if (!checked.ok) {
                plan.dropped.push({ name: call.name, reason: checked.reason, ...(checked.detail ? { detail: checked.detail } : {}) });
            } else if (!plan.draft) {
                plan.draft = checked.draft;
            }
            continue;
        }
        if (call.name === 'offer_plan') {
            // Only when the user asks to buy: a price question or a comparison gets words, not a payment card.
            if (!asksToBuy(message, last?.role === 'model' ? last.text : null)) {
                plan.dropped.push({ name: call.name, reason: 'not_buying' });
                continue;
            }
            const offered = context.plans.find(item => item.code === String(args.plan_code ?? ''));
            const months = args.months === undefined || args.months === null || args.months === ''
                ? null : Number(args.months);
            if (!offered) {
                plan.dropped.push({ name: call.name, reason: 'unknown_id' });
            } else if (months !== null && months !== 1 && months !== 12) {
                plan.dropped.push({ name: call.name, reason: 'bad_value' });
            } else if (!plan.offer) {
                plan.offer = { plan: offered, months: months as 1 | 12 | null };
            }
            continue;
        }
        let proposal: ProposedAction;
        if (call.name === 'control_device') {
            const action = context.actions.find(item => item.id === String(args.action_id ?? ''));
            if (!action) {
                plan.dropped.push({ name: call.name, reason: 'unknown_id' });
                continue;
            }
            let operationInput: Record<string, unknown> = {};
            if (action.input) {
                const parsed = parseValue(action.input.schema, args.value);
                if (!parsed.ok) {
                    plan.dropped.push({ name: call.name, reason: parsed.reason });
                    continue;
                }
                operationInput = { [action.input.name]: parsed.value };
            }
            proposal = { kind: 'device', action, input: operationInput, quote };
        } else {
            const scene = context.scenes.find(item => item.id === String(args.scene_id ?? ''));
            if (!scene) {
                plan.dropped.push({ name: call.name, reason: 'unknown_id' });
                continue;
            }
            proposal = { kind: 'scene', scene, quote };
        }
        const key = proposal.kind === 'device'
            ? `${proposal.action.id}:${JSON.stringify(proposal.input)}` : proposal.scene.id;
        if (seen.has(key)) continue;
        seen.add(key);
        if (plan.actions.length >= MAX_ACTIONS) {
            plan.dropped.push({ name: call.name, reason: 'too_many' });
            continue;
        }
        plan.actions.push(proposal);
    }
    // A question back means the model is unsure: run (offer, draft, look up) nothing this turn.
    if (plan.clarification && (plan.actions.length > 0 || plan.offer || plan.draft || plan.lookups.length > 0
        || plan.weather.length > 0)) {
        plan.dropped.push(...plan.actions.map(item => ({
            name: item.kind === 'device' ? 'control_device' : 'run_scene', reason: 'ambiguous' as const,
        })));
        if (plan.offer) plan.dropped.push({ name: 'offer_plan', reason: 'ambiguous' });
        if (plan.draft) plan.dropped.push({ name: 'draft_automation', reason: 'ambiguous' });
        plan.dropped.push(...plan.lookups.map(() => ({ name: 'look_up_history', reason: 'ambiguous' as const })));
        plan.dropped.push(...plan.weather.map(() => ({ name: 'look_up_weather', reason: 'ambiguous' as const })));
        plan.lookups = [];
        plan.weather = [];
        plan.actions = [];
        plan.offer = null;
        plan.draft = null;
    }
    return plan;
}
