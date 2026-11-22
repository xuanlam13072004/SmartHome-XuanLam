import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { httpError } from '../../utils/httpError';
import type { ConditionInput, TriggerInput } from '../automations/schemas';
import { announceChange, inTransaction, insertAutomation, resolveAutomation } from '../automations/service';
import { freeName } from '../automations/suggestions';
import type { SceneStepInput } from '../scenes/schemas';
import { insertScene, resolveSteps } from '../scenes/service';
import { type AutomationDraft, type DraftComparison, type DraftView, draftView, type SceneIcon } from './drafts';
import { appendHistory } from './memory';

/**
 * Drafts wait in Redis for 30 minutes until the user taps "Lưu"; saving runs
 * the normal scene and automation checks again (devices and permissions may
 * have changed) and creates both in one transaction.
 */

const DRAFT_SECONDS = 30 * 60;

interface StoredDraft {
    name: string;
    icon: SceneIcon;
    steps: SceneStepInput[];
    automation: {
        trigger: TriggerInput;
        conditions: ConditionInput[];
        window: { from: string; to: string } | null;
        notify_message: string | null;
    } | null;
}

const draftKey = (accountId: string, id: string) => `assistant:draft:${accountId}:${id}`;

const comparisonInput = (item: DraftComparison) => ({
    mac: item.watch.mac, property: item.watch.property, operator: item.operator, value: item.value,
});

/** Keeps the draft; returns what the app shows. */
export async function storeDraft(app: Pick<FastifyInstance, 'redis'>, accountId: string, draft: AutomationDraft): Promise<DraftView> {
    const id = crypto.randomBytes(9).toString('base64url');
    const trigger = draft.trigger;
    const stored: StoredDraft = {
        name: draft.name,
        icon: draft.icon,
        steps: draft.steps.map(step => ({
            mac: step.action.mac,
            instance_id: step.action.instance_id,
            operation: step.action.operation,
            input: step.input,
            delay_seconds: step.delay_seconds,
        })),
        automation: !trigger ? null : {
            trigger: trigger.kind === 'time' ? { kind: 'time', time: trigger.time, days: trigger.days }
                : trigger.kind === 'state' ? { kind: 'state', ...comparisonInput(trigger) }
                    : { kind: 'event', mac: trigger.event.mac, event: trigger.event.event },
            conditions: draft.conditions.map(comparisonInput),
            window: draft.window,
            notify_message: draft.notify_message,
        },
    };
    await app.redis.set(draftKey(accountId, id), JSON.stringify(stored), 'EX', DRAFT_SECONDS);
    return draftView(id, draft);
}

/**
 * Creates the draft's scene and/or automation, checked again with the normal
 * rules (the user's devices and permissions may have changed). Names that are
 * taken get a number, like suggestions.
 */
export async function saveDraft(app: FastifyInstance, accountId: string, id: string, timezone: string) {
    const raw = await app.redis.get(draftKey(accountId, id));
    if (!raw) throw httpError(404, 'ASSISTANT_DRAFT_NOT_FOUND', 'Bản nháp đã hết hạn, hãy nhờ trợ lý soạn lại.');
    const stored = JSON.parse(raw) as StoredDraft;
    const steps = stored.steps.length > 0 ? await resolveSteps(app, accountId, stored.steps) : null;
    const resolved = stored.automation ? await resolveAutomation(app, accountId, {
        name: stored.name,
        enabled: true,
        timezone,
        trigger: stored.automation.trigger,
        conditions: stored.automation.conditions,
        window: stored.automation.window,
        scene_id: null,
        notify_message: stored.automation.notify_message,
        cooldown_seconds: 300,
    }) : null;
    const saved = await inTransaction(app, async (client) => {
        let name = stored.name;
        let sceneId: string | null = null;
        let automationId: string | null = null;
        if (steps) {
            name = await freeName(client, 'scenes', accountId, stored.name);
            sceneId = await insertScene(client, accountId, { name, icon: stored.icon, steps });
        }
        if (resolved) {
            name = await freeName(client, 'automations', accountId, stored.name);
            automationId = await insertAutomation(app, client, accountId, {
                ...resolved, input: { ...resolved.input, name, scene_id: sceneId },
            });
        }
        return { sceneId, automationId, name };
    });
    if (saved.automationId) await announceChange(app, saved.automationId);
    await app.redis.del(draftKey(accountId, id));
    const reply = saved.automationId
        ? `Đã lưu và bật tự động hóa "${saved.name}".`
        : `Đã tạo kịch bản "${saved.name}". Bạn chạy nó trong mục Kịch bản hoặc nhờ mình nhé.`;
    await appendHistory(app, accountId, [{ role: 'model', text: reply }]);
    return { scene_id: saved.sceneId, automation_id: saved.automationId, reply };
}
