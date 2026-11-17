import { z } from 'zod';

/** Icons the app knows how to draw (scene_icons.dart). */
export const SCENE_ICONS = [
    'play', 'leave_home', 'arrive_home', 'sleep', 'wake_up', 'water',
    'lock', 'shield', 'sun', 'moon', 'rain', 'party',
] as const;

const mac = z.string().trim().toUpperCase().regex(/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/, 'Invalid MAC address');
const identifier = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const sceneName = z.string()
    .transform(value => value.replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim())
    .pipe(z.string().min(1).max(60));
const icon = z.enum(SCENE_ICONS);
const sceneId = z.string().uuid();

const step = z.object({
    mac,
    instance_id: identifier,
    operation: identifier,
    input: z.record(z.unknown()).default({})
        .refine(value => JSON.stringify(value).length <= 2048, 'Input is too large'),
    // Wait before this step (the first step starts right away).
    delay_seconds: z.number().int().min(0).max(3600).default(0),
}).strict();

// The per-account step limit (MAX_SCENE_STEPS) is checked by the service.
const steps = z.array(step).min(1).max(20);

export const createSceneSchema = z.object({
    body: z.object({ name: sceneName, icon: icon.default('play'), steps }).strict(),
});

export const updateSceneSchema = z.object({
    params: z.object({ sceneId }),
    body: z.object({ name: sceneName.optional(), icon: icon.optional(), steps: steps.optional() }).strict()
        .refine(body => body.name !== undefined || body.icon !== undefined || body.steps !== undefined,
            'Nothing to change'),
});

export const sceneParamsSchema = z.object({
    params: z.object({ sceneId }),
});

export const reorderScenesSchema = z.object({
    body: z.object({ scene_ids: z.array(sceneId).max(500) }).strict(),
});

export const listRunsSchema = z.object({
    query: z.object({
        scene_id: sceneId.optional(),
        before: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(50).default(20),
    }).strict(),
});

export const runParamsSchema = z.object({
    params: z.object({ runId: z.string().uuid() }),
});

// ── Schedules ──────────────────────────────────────────────────────────────

const localTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');
// ISO weekdays, 1 = Monday … 7 = Sunday; stored sorted without repeats.
const weekdays = z.array(z.number().int().min(1).max(7)).min(1).max(7)
    .transform(days => [...new Set(days)].sort((a, b) => a - b));
// An IANA name such as Asia/Ho_Chi_Minh; PostgreSQL checks that it exists.
const timezone = z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_+\-/]*$/);
const scheduleId = z.string().uuid();

export const createScheduleSchema = z.object({
    params: z.object({ sceneId }),
    body: z.object({ time: localTime, days: weekdays, timezone }).strict(),
});

export const updateScheduleSchema = z.object({
    params: z.object({ scheduleId }),
    body: z.object({
        time: localTime.optional(),
        days: weekdays.optional(),
        timezone: timezone.optional(),
        enabled: z.boolean().optional(),
    }).strict().refine(body => Object.keys(body).length > 0, 'Nothing to change'),
});

export const scheduleParamsSchema = z.object({
    params: z.object({ scheduleId }),
});

export type SceneStepInput = z.infer<typeof step>;
