import { z } from 'zod';
import { WEATHER_CONDITION_IDS } from '../weather/forecast';

const mac = z.string().trim().toUpperCase().regex(/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/, 'Invalid MAC address');
const name = z.string()
    .transform(value => value.replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim())
    .pipe(z.string().min(1).max(60));
const message = z.string()
    .transform(value => value.replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim())
    .pipe(z.string().min(1).max(160));
const localTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');
// ISO weekdays, 1 = Monday … 7 = Sunday; stored sorted without repeats.
const weekdays = z.array(z.number().int().min(1).max(7)).min(1).max(7)
    .transform(days => [...new Set(days)].sort((a, b) => a - b));
// An IANA name such as Asia/Ho_Chi_Minh; PostgreSQL checks that it exists.
const timezone = z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_+\-/]*$/);
// Catalog property path ('instances.door_position.reported.door_state').
const property = z.string().max(128).regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,3}$/);
const operator = z.enum(['eq', 'ne', 'gt', 'lt']);
const value = z.union([z.boolean(), z.number().finite(), z.string().max(64)]);
const automationId = z.string().uuid();

const trigger = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('state'), mac, property, operator, value }).strict(),
    z.object({
        kind: z.literal('event'),
        mac,
        event: z.string().max(128).regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/),
    }).strict(),
    z.object({ kind: z.literal('time'), time: localTime, days: weekdays }).strict(),
]);

const deviceCondition = z.object({ mac, property, operator, value }).strict();
// The weather at the account's home (docs/architecture/weather.md): only in "Nếu".
const weatherCondition = z.object({
    weather: z.enum(WEATHER_CONDITION_IDS as [string, ...string[]]),
    operator,
    value,
}).strict();
const condition = z.union([deviceCondition, weatherCondition]);

const definition = z.object({
    name,
    enabled: z.boolean().default(true),
    timezone,
    trigger,
    conditions: z.array(condition).max(3).default([]),
    // Only between these local times; `to` before `from` runs past midnight.
    window: z.object({ from: localTime, to: localTime }).strict()
        .refine(range => range.from !== range.to, 'The window cannot be empty')
        .nullable().default(null),
    scene_id: z.string().uuid().nullable().default(null),
    notify_message: message.nullable().default(null),
    cooldown_seconds: z.union([z.literal(60), z.literal(300), z.literal(900), z.literal(3600)]).default(300),
}).strict().refine(body => body.scene_id !== null || body.notify_message !== null, {
    message: 'Choose a scene to run or a notification to send',
    path: ['scene_id'],
});

export const createAutomationSchema = z.object({ body: definition });

export const replaceAutomationSchema = z.object({
    params: z.object({ automationId }),
    body: definition,
});

export const setEnabledSchema = z.object({
    params: z.object({ automationId }),
    body: z.object({ enabled: z.boolean() }).strict(),
});

export const automationParamsSchema = z.object({
    params: z.object({ automationId }),
});

export const applySuggestionSchema = z.object({
    body: z.object({ key: z.string().min(1).max(160), timezone }).strict(),
});

export type AutomationInput = z.infer<typeof definition>;
export type TriggerInput = z.infer<typeof trigger>;
export type ConditionInput = z.infer<typeof condition>;
export type DeviceConditionInput = z.infer<typeof deviceCondition>;
export type WeatherConditionInput = z.infer<typeof weatherCondition>;
