import type { Plan } from '../../src/modules/assistant/planner';

/** One sentence of the prompt test set (cases.json). */
export interface AssistantCase {
    id: number;
    say: string;
    expect: 'act' | 'ask' | 'none' | 'allow';
    actions?: Array<{ device: string; label: string; value?: unknown }>;
    scenes?: string[];
    history?: Array<{ role: 'user' | 'model'; text: string; clarify?: boolean }>;
    note?: string;
}

/**
 * wrong_command: something ran that should not (the number that must stay 0);
 * missed: an expected command did not run; not_asked: no question back when one was needed.
 */
export type Verdict = 'pass' | 'wrong_command' | 'missed' | 'not_asked';

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

export function scoreCase(item: AssistantCase, plan: Plan): Verdict {
    const got = planKeys(plan);
    const expected = expectedKeys(item);
    switch (item.expect) {
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
