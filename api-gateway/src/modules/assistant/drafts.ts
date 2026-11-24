import { env } from '../../config/env';
import { weatherConditionText } from '../weather/forecast';
import { type Operator, validComparison } from '../automations/catalog';
import { comparisonLabel, daysLabel, durationLabel, valueLabel } from '../automations/labels';
import { SCENE_ICONS } from '../scenes/schemas';
import type { AssistantAction, AssistantEvent, AssistantWatch, HomeContext } from './context';
import { clip } from './text';
import { FALSE, parseValue, TRUE } from './values';

/**
 * Scenes and automations the assistant drafts from what the user says
 * ("mỗi tối 10 giờ khóa cửa", "khi trời mưa thì đóng mái"). The model fills
 * draft_automation with ids from this turn's home data; every part is checked
 * here with the rules of the Kịch bản screens (pure, no database). The draft
 * is kept and saved by draftStore.ts once the user taps "Lưu".
 */

export type SceneIcon = typeof SCENE_ICONS[number];

export interface DraftComparison {
    watch: AssistantWatch;
    operator: Operator;
    value: string | number | boolean;
}

export type DraftTrigger =
    | { kind: 'time'; time: string; days: number[] }
    | ({ kind: 'state' } & DraftComparison)
    | { kind: 'event'; event: AssistantEvent };

export interface DraftStep {
    action: AssistantAction;
    input: Record<string, unknown>;
    delay_seconds: number;
}

export interface AutomationDraft {
    name: string;
    icon: SceneIcon;
    /** Null: a scene the user runs by hand. */
    trigger: DraftTrigger | null;
    conditions: DraftComparison[];
    window: { from: string; to: string } | null;
    steps: DraftStep[];
    notify_message: string | null;
}

export type DraftProblem = 'unknown_id' | 'bad_value' | 'missing_value' | 'too_many' | 'protected_step';

export const MAX_CONDITIONS = 3;
const MAX_DELAY_SECONDS = 3600;
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];

/** 'HH:MM' from "6:30", "06:30" or "6h30"; null when it is not a time of day. */
export function normalizeTime(raw: unknown): string | null {
    const match = /^(\d{1,2})[:h](\d{2})$/.exec(String(raw ?? '').trim().toLowerCase());
    if (!match) return null;
    const [hours, minutes] = [Number(match[1]), Number(match[2])];
    if (hours > 23 || minutes > 59) return null;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function comparisonValue(watch: AssistantWatch, raw: unknown): string | number | boolean | null {
    const text = String(raw ?? '').trim();
    if (watch.kind === 'boolean') {
        if (typeof raw === 'boolean') return raw;
        if (TRUE.has(text.toLowerCase())) return true;
        if (FALSE.has(text.toLowerCase())) return false;
        return null;
    }
    if (watch.kind === 'enum') return watch.enum!.find(item => item.toLowerCase() === text.toLowerCase()) ?? null;
    const value = Number(text.replace(',', '.'));
    return text !== '' && Number.isFinite(value) ? value : null;
}

function comparison(context: HomeContext, raw: any, use: 'trigger' | 'condition'): DraftComparison | DraftProblem {
    const watch = context.watches.find(item => item.id === String(raw?.watch_id ?? ''));
    if (!watch || !watch[use]) return 'unknown_id';
    const operator = String(raw?.operator || (watch.kind === 'number' ? '' : 'eq')) as Operator;
    const value = comparisonValue(watch, raw?.value);
    if (value === null || !validComparison(watch, operator, value)) return 'bad_value';
    return { watch, operator, value };
}

/** The model's draft_automation call, checked; never repaired. */
export function checkDraft(args: Record<string, any>, context: HomeContext):
    { ok: true; draft: AutomationDraft } | { ok: false; reason: DraftProblem; detail?: string } {
    const fail = (reason: DraftProblem, detail?: string) => ({ ok: false as const, reason, ...(detail ? { detail } : {}) });

    let trigger: DraftTrigger | null = null;
    switch (String(args.trigger ?? 'none')) {
        case 'none':
            break;
        case 'time': {
            const time = normalizeTime(args.time);
            const rawDays = Array.isArray(args.days) ? args.days.map(Number) : [];
            const days = rawDays.length === 0 ? ALL_DAYS : [...new Set(rawDays)].sort((a, b) => a - b);
            if (!time || days.some(day => !Number.isInteger(day) || day < 1 || day > 7)) return fail('bad_value');
            trigger = { kind: 'time', time, days };
            break;
        }
        case 'watch': {
            const checked = comparison(context, args, 'trigger');
            if (typeof checked === 'string') return fail(checked);
            trigger = { kind: 'state', ...checked };
            break;
        }
        case 'event': {
            const event = context.events.find(item => item.id === String(args.event_id ?? ''));
            if (!event) return fail('unknown_id');
            trigger = { kind: 'event', event };
            break;
        }
        default:
            return fail('bad_value');
    }

    const rawConditions: any[] = Array.isArray(args.conditions) ? args.conditions : [];
    if (rawConditions.length > MAX_CONDITIONS) return fail('too_many');
    const conditions: DraftComparison[] = [];
    for (const raw of rawConditions) {
        const checked = comparison(context, raw, 'condition');
        if (typeof checked === 'string') return fail(checked);
        conditions.push(checked);
    }

    let window: AutomationDraft['window'] = null;
    if (args.only_from || args.only_to) {
        const from = normalizeTime(args.only_from);
        const to = normalizeTime(args.only_to);
        if (!from || !to || from === to) return fail('bad_value');
        window = { from, to };
    }

    const rawSteps: any[] = Array.isArray(args.steps) ? args.steps : [];
    if (rawSteps.length > env.MAX_SCENE_STEPS) return fail('too_many');
    const steps: DraftStep[] = [];
    for (const raw of rawSteps) {
        const action = context.actions.find(item => item.id === String(raw?.action_id ?? ''));
        if (!action) return fail('unknown_id');
        let input: Record<string, unknown> = {};
        if (action.input) {
            const parsed = parseValue(action.input.schema, raw?.value);
            if (!parsed.ok) return fail(parsed.reason);
            input = { [action.input.name]: parsed.value };
        }
        const delay = raw?.delay_seconds === undefined || raw?.delay_seconds === null || raw?.delay_seconds === ''
            ? 0 : Number(raw.delay_seconds);
        if (!Number.isInteger(delay) || delay < 0 || delay > MAX_DELAY_SECONDS) return fail('bad_value');
        steps.push({ action, input, delay_seconds: steps.length === 0 ? 0 : delay });
    }

    const notify = clip(String(args.notify_message ?? ''), 160) || null;
    if (trigger) {
        if (steps.length === 0 && !notify) return fail('missing_value');
        // Nobody is there to confirm or type the password when it runs by itself.
        const guarded = steps.find(step => step.action.confirmation !== null);
        if (guarded) return fail('protected_step', guarded.action.label);
    } else if (steps.length === 0) {
        return fail('missing_value');
    }

    const icon = (SCENE_ICONS as readonly string[]).includes(String(args.icon)) ? args.icon as SceneIcon : 'play';
    const name = clip(String(args.name ?? '').replace(/[\u0000-\u001f\u007f]/g, ''), 60)
        || (trigger?.kind === 'time' ? `Hẹn giờ ${trigger.time}` : trigger ? 'Tự động hóa mới' : 'Kịch bản mới');
    return {
        ok: true,
        draft: { name, icon, trigger, conditions, window, steps, notify_message: trigger ? notify : null },
    };
}

// ── What the user sees ─────────────────────────────────────────────────────

export interface DraftView {
    id: string;
    kind: 'automation' | 'scene';
    name: string;
    trigger: string | null;
    conditions: string[];
    window: string | null;
    steps: Array<{ label: string; delay: string | null }>;
    notify: string | null;
}

function comparisonText(item: DraftComparison): string {
    if (item.watch.weather) return `Thời tiết: ${weatherConditionText(item.watch.weather, item.operator, item.value)}`;
    return `${item.watch.device}: ${comparisonLabel(item.watch.label, item.watch.property, item.operator, item.value, item.watch.unit)}`;
}

function inputText(action: AssistantAction, input: Record<string, unknown>): string {
    if (!action.input) return '';
    const value = input[action.input.name];
    const schema = action.input.schema;
    if (typeof value === 'number' && (schema.unit === 'second' || action.input.name.endsWith('_seconds'))) {
        return ` (${durationLabel(value)})`;
    }
    if (typeof value === 'boolean') return value ? ' (bật)' : ' (tắt)';
    return ` (${valueLabel(action.input.name, value, schema.unit)})`;
}

export function draftView(id: string, draft: AutomationDraft): DraftView {
    const trigger = draft.trigger;
    return {
        id,
        kind: trigger ? 'automation' : 'scene',
        name: draft.name,
        trigger: !trigger ? null
            : trigger.kind === 'time' ? `${daysLabel(trigger.days)} lúc ${trigger.time}`
                : trigger.kind === 'state' ? `Khi ${comparisonText(trigger)}`
                    : `Khi ${trigger.event.device}: ${trigger.event.label}`,
        conditions: draft.conditions.map(item => `Nếu ${comparisonText(item)}`),
        window: draft.window ? `Chỉ từ ${draft.window.from} đến ${draft.window.to}` : null,
        steps: draft.steps.map(step => ({
            label: `${step.action.label} · ${step.action.device}${inputText(step.action, step.input)}`,
            delay: step.delay_seconds > 0 ? `sau ${durationLabel(step.delay_seconds)}` : null,
        })),
        notify: draft.notify_message,
    };
}

/** The assistant's reply to a draft, written by the server. */
export function draftReply(view: DraftView): string {
    const steps = view.steps.map(step => (step.delay ? `${step.label} ${step.delay}` : step.label));
    if (view.kind === 'scene') {
        return `Mình soạn sẵn kịch bản "${view.name}": ${steps.join(', ')}. Bấm Lưu để tạo, rồi bạn chạy nó bất cứ lúc nào.`;
    }
    const what = [...steps, ...(view.notify ? [`gửi thông báo "${view.notify}"`] : [])].join(', ');
    const extra = [...view.conditions, ...(view.window ? [view.window] : [])].join(', ');
    return `Mình soạn sẵn tự động hóa "${view.name}": ${view.trigger}${extra ? ` (${extra})` : ''} → ${what}. `
        + 'Bạn xem lại rồi bấm Lưu để bật nhé.';
}

/** Why a draft could not be made, in words (null: say nothing special). */
export function draftProblemReply(reason: string, detail?: string): string | null {
    if (reason === 'protected_step') {
        return `"${detail ?? 'Thao tác này'}" cần bạn xác nhận hoặc nhập mật khẩu mỗi lần, nên không thể chạy tự động. `
            + 'Mình có thể tạo một kịch bản để bạn chạy bằng tay.';
    }
    if (reason === 'too_many') return `Một kịch bản có tối đa ${env.MAX_SCENE_STEPS} bước và ${MAX_CONDITIONS} điều kiện.`;
    return null;
}
