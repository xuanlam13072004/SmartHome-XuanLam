import type { Plan } from '../../src/modules/assistant/planner';

/** One sentence of the prompt test set (cases.json). */
export interface AssistantCase {
    id: number;
    say: string;
    expect: 'act' | 'ask' | 'none' | 'allow' | 'offer' | 'draft';
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
    };
    scenes?: string[];
    history?: Array<{ role: 'user' | 'model'; text: string; clarify?: boolean }>;
    note?: string;
}

/**
 * wrong_command: something ran that should not (the number that must stay 0);
 * missed: an expected command or offer did not come; not_asked: no question back when one was needed;
 * wrong_offer: a plan offer nobody asked for, or the wrong plan or months (the user still has to confirm it);
 * wrong_draft: a scene/automation draft nobody asked for, or a wrong one (the user still has to save it).
 */
export type Verdict = 'pass' | 'wrong_command' | 'missed' | 'not_asked' | 'wrong_offer' | 'wrong_draft';

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
    return expected.notify === undefined || Boolean(draft.notify_message) === expected.notify;
}

export function scoreCase(item: AssistantCase, plan: Plan): Verdict {
    const commands = scoreCommands(item, plan);
    if (commands !== 'pass') return commands;
    if (item.expect !== 'offer' && plan.offer) return 'wrong_offer';
    if (item.expect !== 'draft' && plan.draft) return 'wrong_draft';
    return 'pass';
}

function scoreCommands(item: AssistantCase, plan: Plan): Verdict {
    const got = planKeys(plan);
    const expected = expectedKeys(item);
    switch (item.expect) {
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
