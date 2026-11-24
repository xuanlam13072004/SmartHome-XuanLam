import type { Plan } from '../../src/modules/assistant/planner';

/** One sentence of the prompt test set (cases.json). */
export interface AssistantCase {
    id: number;
    say: string;
    expect: 'act' | 'ask' | 'none' | 'allow' | 'offer' | 'draft' | 'history' | 'weather';
    actions?: Array<{ device: string; label: string; value?: unknown }>;
    /** expect 'offer': the plan the chat should offer, and the months only if the user said them. */
    offer?: { plan: string; months: 1 | 12 | null };
    /** expect 'draft': what the preview holds; only the parts given are checked. */
    draft?: {
        /** device: a state or an event of a device. */
        trigger: 'time' | 'device' | 'none';
        time?: string;
        days?: number[];
        steps?: Array<{ device: string; label: string; value?: unknown }>;
        notify?: boolean;
        /** Weather conditions ("rain_next_12h=false", "temperature>35"); "a|b": either is right. */
        weather?: string[];
    };
    scenes?: string[];
    /**
     * expect 'history' (or 'act' asking too): history the model must look up; [what] lists the
     * acceptable kinds, [device] the device name (or [run] the scene/automation name, "" = all), [period] if it matters.
     */
    lookups?: Array<{ what: string[]; device?: string; run?: string; period?: string }>;
    /**
     * expect 'weather' (or 'act' asking too): forecasts the model must read; [when] lists the
     * acceptable days, [from_hour]/[to_hour] the part of the day if it matters (±2 hours).
     */
    weather?: Array<{ when: string[]; from_hour?: number; to_hour?: number }>;
    history?: Array<{ role: 'user' | 'model'; text: string; clarify?: boolean; history?: boolean }>;
    note?: string;
}

/**
 * wrong_command: something ran that should not (the number that must stay 0);
 * missed: an expected command or offer did not come; not_asked: no question back when one was needed;
 * wrong_offer: a plan offer nobody asked for, or the wrong plan or months (the user still has to confirm it);
 * wrong_draft: a scene/automation draft nobody asked for, or a wrong one (the user still has to save it);
 * wrong_history: history or weather nobody asked about was looked up, or the wrong device/kind/period (it only reads).
 */
export type Verdict = 'pass' | 'wrong_command' | 'missed' | 'not_asked' | 'wrong_offer' | 'wrong_draft' | 'wrong_history';

/** What the model looked up, for display and comparison. */
export function lookupKeys(plan: Plan): string[] {
    return plan.lookups.map(lookup => {
        const target = lookup.what === 'runs' ? (lookup.scene?.name ?? lookup.automation?.name ?? '') : lookup.device.device;
        return `${lookup.what}|${target}|${lookup.window.label}`;
    });
}

/** What forecasts the model read, for display and comparison. */
export function weatherKeys(plan: Plan): string[] {
    return plan.weather.map(lookup => `weather|${lookup.label}`);
}

/** The Vietnam hour of [date] (0–23). */
const localHour = (date: Date) => new Date(date.getTime() + 7 * 3_600_000).getUTCHours();

function weatherMatches(expected: NonNullable<AssistantCase['weather']>, plan: Plan): boolean {
    return expected.every(want => plan.weather.some(lookup => {
        if (!want.when.includes(lookup.when)) return false;
        if (want.from_hour !== undefined && Math.abs(localHour(lookup.start) - want.from_hour) > 2) return false;
        return want.to_hour === undefined || Math.abs((localHour(lookup.end) || 24) - want.to_hour) <= 2;
    }));
}

function lookupsMatch(expected: NonNullable<AssistantCase['lookups']>, plan: Plan): boolean {
    return expected.every(want => plan.lookups.some(lookup => {
        if (!want.what.includes(lookup.what)) return false;
        if (lookup.what === 'runs') {
            if (want.run === undefined) return true;
            return (lookup.scene?.name ?? lookup.automation?.name ?? '') === want.run;
        }
        if (want.device !== undefined && lookup.device.device !== want.device) return false;
        return want.period === undefined || lookup.window.label.startsWith(want.period);
    }));
}

export function expectedKeys(item: AssistantCase): string[] {
    return [
        ...(item.actions ?? []).map(action => `${action.device}|${action.label}|${action.value ?? ''}`),
        ...(item.scenes ?? []).map(scene => `scene|${scene}`),
    ];
}

/** What would run, after the server's checks. */
export function planKeys(plan: Plan): string[] {
    return plan.actions.map(action => {
        if (action.kind === 'scene') return `scene|${action.scene.name}`;
        const value = action.action.input ? action.input[action.action.input.name] : '';
        return `${action.action.device}|${action.action.label}|${value ?? ''}`;
    });
}

/** What a draft would create, for display and comparison. */
export function draftKeys(plan: Plan): string[] {
    return (plan.draft?.steps ?? []).map(step => {
        const value = step.action.input ? step.input[step.action.input.name] : '';
        return `${step.action.device}|${step.action.label}|${value ?? ''}`;
    });
}

function draftMatches(expected: NonNullable<AssistantCase['draft']>, plan: Plan): boolean {
    const draft = plan.draft!;
    const trigger = draft.trigger;
    const kind = !trigger ? 'none' : trigger.kind === 'time' ? 'time' : 'device';
    if (kind !== expected.trigger) return false;
    if (expected.time && (trigger?.kind !== 'time' || trigger.time !== expected.time)) return false;
    if (expected.days && (trigger?.kind !== 'time' || JSON.stringify(trigger.days) !== JSON.stringify(expected.days))) return false;
    if (expected.steps) {
        const want = expected.steps.map(step => `${step.device}|${step.label}|${step.value ?? ''}`).sort();
        if (JSON.stringify(draftKeys(plan).sort()) !== JSON.stringify(want)) return false;
    }
    if (expected.weather) {
        const got = weatherConditionKeys(plan).sort();
        if (got.length !== expected.weather.length) return false;
        if (!expected.weather.every(want => want.split('|').some(choice => got.includes(choice)))) return false;
    }
    return expected.notify === undefined || Boolean(draft.notify_message) === expected.notify;
}

const SIGNS: Record<string, string> = { eq: '=', ne: '!=', gt: '>', lt: '<' };

/** The weather conditions of a draft ("rain_next_12h=false"). */
export function weatherConditionKeys(plan: Plan): string[] {
    return (plan.draft?.conditions ?? [])
        .filter(item => item.watch.weather)
        .map(item => `${item.watch.weather}${SIGNS[item.operator]}${item.value}`);
}

export function scoreCase(item: AssistantCase, plan: Plan): Verdict {
    const commands = scoreCommands(item, plan);
    if (commands !== 'pass') return commands;
    if (item.expect !== 'offer' && plan.offer) return 'wrong_offer';
    if (item.expect !== 'draft' && plan.draft) return 'wrong_draft';
    if (item.lookups) {
        if (plan.lookups.length === 0) return 'missed';
        if (!lookupsMatch(item.lookups, plan)) return 'wrong_history';
    } else if (plan.lookups.length > 0 && item.expect !== 'allow') {
        return 'wrong_history';
    }
    if (item.weather) {
        if (plan.weather.length === 0) return 'missed';
        if (!weatherMatches(item.weather, plan)) return 'wrong_history';
    } else if (plan.weather.length > 0 && item.expect !== 'allow') {
        return 'wrong_history';
    }
    return 'pass';
}

function scoreCommands(item: AssistantCase, plan: Plan): Verdict {
    const got = planKeys(plan);
    const expected = expectedKeys(item);
    switch (item.expect) {
        case 'history':
        case 'weather':
            return got.length > 0 ? 'wrong_command' : 'pass';
        case 'draft':
            if (got.length > 0) return 'wrong_command';
            if (!plan.draft) return 'missed';
            return draftMatches(item.draft!, plan) ? 'pass' : 'wrong_draft';
        case 'offer':
            if (got.length > 0) return 'wrong_command';
            if (!plan.offer) return 'missed';
            return plan.offer.plan.code === item.offer?.plan && plan.offer.months === item.offer?.months
                ? 'pass' : 'wrong_offer';
        case 'act':
            if (got.some(key => !expected.includes(key))) return 'wrong_command';
            return expected.every(key => got.includes(key)) ? 'pass' : 'missed';
        case 'allow':
            return got.some(key => !expected.includes(key)) ? 'wrong_command' : 'pass';
        case 'none':
            return got.length > 0 ? 'wrong_command' : 'pass';
        case 'ask':
            if (got.length > 0) return 'wrong_command';
            return plan.clarification || /\?/.test(plan.text ?? '') ? 'pass' : 'not_asked';
    }
}
