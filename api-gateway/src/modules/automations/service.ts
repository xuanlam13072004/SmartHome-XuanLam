import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { REDIS_CHANNELS } from '../../../../shared/constants';
import { env } from '../../config/env';
import { httpError } from '../../utils/httpError';
import { loadAccessibleDevices } from '../device/service';
import { assertTimezone, sceneHasProtectedSteps } from '../scenes/schedules';
import { lockAccount } from '../scenes/service';
import {
    automationEvents,
    automationProperties,
    compare,
    findEvent,
    findProperty,
    type Operator,
    shadowValue,
    validComparison,
} from './catalog';
import type { AutomationInput, DeviceConditionInput } from './schemas';
import { findWeatherCondition, validWeatherComparison, weatherConditionOptions } from '../weather/forecast';
import { homeLocation, weatherEnabled } from '../weather/service';

/**
 * Automations ("Tự động"): Khi (a device state, a device event or a time) →
 * Nếu (up to 3 device states or weather at home, an active window) → Thì (run
 * a scene and/or notify the account). Saving checks everything against the caller's devices
 * and the catalog; the engine (workers/automationEngine.ts, firing.ts) runs them.
 */

interface DeviceRef {
    mac: string;
    name: string;
    product_id: string;
}

type TriggerView =
    | {
        kind: 'state';
        device: DeviceRef | null;
        property: string;
        label: string;
        instance_label: string;
        operator: Operator;
        value: unknown;
        unit: string | null;
        available: boolean;
    }
    | {
        kind: 'event';
        device: DeviceRef | null;
        event: string;
        capability_id: string | null;
        event_name: string;
        instance_label: string;
        available: boolean;
    }
    | { kind: 'time'; time: string; days: number[] };

interface ConditionView {
    /** 'weather': the weather at the account's home (device is null, property 'weather.<id>'). */
    kind: 'device' | 'weather';
    device: DeviceRef | null;
    property: string;
    label: string;
    instance_label: string;
    operator: Operator;
    value: unknown;
    unit: string | null;
    available: boolean;
}

export interface AutomationView {
    id: string;
    name: string;
    enabled: boolean;
    trigger: TriggerView;
    conditions: ConditionView[];
    window: { from: string; to: string } | null;
    timezone: string;
    scene: { id: string; name: string } | null;
    notify_message: string | null;
    cooldown_seconds: number;
    suggestion: string | null;
    next_run_at: string | null;
    last_triggered_at: string | null;
    last_result: string | null;
    /** Why the last occurrence did nothing besides the devices ('weather_unavailable'). */
    last_skip_reason: string | null;
    last_run_id: string | null;
}

export type StoredCondition =
    | { device_id: string; property: string; operator: Operator; value: unknown; kind?: undefined }
    | { kind: 'weather'; weather: string; operator: Operator; value: unknown };

export const isWeatherCondition = (condition: StoredCondition): condition is Extract<StoredCondition, { kind: 'weather' }> =>
    condition.kind === 'weather';

const PROTECTED_SCENE = () => httpError(400, 'SCENE_PROTECTED_STEPS',
    'A scene with steps that need the password cannot run automatically');

/** Publishes AUTOMATION_CHANGED so every Gateway reloads [id]; the periodic resync covers a lost message. */
export async function announceChange(app: FastifyInstance, id: string) {
    try {
        await app.redis.publish(REDIS_CHANNELS.AUTOMATION_CHANGED, JSON.stringify({ id }));
    } catch (error) {
        app.log.warn({ error, id }, 'Failed to announce an automation change');
    }
}

export async function inTransaction<T>(app: FastifyInstance, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await app.pg.connect();
    try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
    } catch (error: any) {
        await client.query('ROLLBACK');
        throw translate(error);
    } finally {
        client.release();
    }
}

export function translate(error: any) {
    if (error?.code === '23505' && error.constraint === 'uq_automations_suggestion') {
        return httpError(409, 'SUGGESTION_ALREADY_ADDED', 'This suggestion has already been added');
    }
    if (error?.code === '23505') {
        return httpError(409, 'AUTOMATION_NAME_TAKEN', 'An automation with this name already exists');
    }
    return error;
}

// ── What the pickers offer ─────────────────────────────────────────────────

/** The weather a condition may check, when the account has a home location (null: weather off). */
export async function weatherOptions(app: FastifyInstance, accountId: string) {
    if (!weatherEnabled()) return null;
    const location = await homeLocation(app, accountId);
    return { place: location?.place ?? null, conditions: weatherConditionOptions() };
}

/** Every device the caller can see, with the states and events an automation may use. */
export async function listAutomationOptions(app: FastifyInstance, accountId: string) {
    const result = await app.pg.query(
        `SELECT device.mac, device.name, device.product_id, device.catalog_revision, membership.room_id
         FROM device_memberships AS membership
         JOIN device_metadata AS device ON device.id = membership.device_id AND device.is_active = true
         WHERE membership.account_id = $1 AND membership.status = 'active'
           AND (membership.expires_at IS NULL OR membership.expires_at > NOW())
         ORDER BY device.name, device.mac`,
        [accountId],
    );
    return result.rows.map(device => {
        const product = app.catalog.getProduct(device.product_id) as any;
        const current = product && product.catalog_revision === device.catalog_revision;
        return {
            mac: device.mac,
            name: device.name,
            product_id: device.product_id,
            room_id: device.room_id,
            triggers: current ? automationProperties(product, 'trigger') : [],
            events: current ? automationEvents(product) : [],
            conditions: current ? automationProperties(product, 'condition') : [],
        };
    }).filter(device => device.triggers.length + device.events.length + device.conditions.length > 0);
}

// ── Views ──────────────────────────────────────────────────────────────────

const VIEW_COLUMNS = `automation.id, automation.name, automation.enabled, automation.trigger_kind,
    automation.trigger_device_id, automation.trigger_property, automation.trigger_operator,
    automation.trigger_value, automation.trigger_event,
    to_char(automation.trigger_time, 'HH24:MI') AS trigger_time, automation.trigger_days,
    automation.timezone, automation.conditions,
    to_char(automation.active_from, 'HH24:MI') AS active_from, to_char(automation.active_to, 'HH24:MI') AS active_to,
    automation.scene_id, scene.name AS scene_name, automation.notify_message, automation.cooldown_seconds,
    automation.suggestion, automation.next_run_at, automation.last_triggered_at, automation.last_result,
    automation.last_skip_reason, automation.last_run_id`;

/** The account's automations, oldest first (or just [automationId]). */
export async function listAutomations(
    app: FastifyInstance,
    accountId: string,
    automationId?: string,
): Promise<AutomationView[]> {
    const rows = (await app.pg.query(
        `SELECT ${VIEW_COLUMNS}
         FROM automations AS automation
         LEFT JOIN scenes AS scene ON scene.id = automation.scene_id
         WHERE automation.account_id = $1 AND ($2::uuid IS NULL OR automation.id = $2)
         ORDER BY automation.created_at, automation.id`,
        [accountId, automationId ?? null],
    )).rows;
    if (rows.length === 0) return [];

    const deviceIds = new Set<string>();
    let weather = false;
    for (const row of rows) {
        if (row.trigger_device_id) deviceIds.add(row.trigger_device_id);
        for (const condition of row.conditions as StoredCondition[]) {
            if (isWeatherCondition(condition)) weather = true;
            else deviceIds.add(condition.device_id);
        }
    }
    // A weather condition works while the account has a home location.
    const weatherAvailable = weather && weatherEnabled() && Boolean(await homeLocation(app, accountId));
    const devices = new Map((await app.pg.query(
        `SELECT device.id, device.mac, device.name, device.product_id, device.catalog_revision,
                device.is_active AND membership.account_id IS NOT NULL AS accessible
         FROM device_metadata AS device
         LEFT JOIN device_memberships AS membership
           ON membership.device_id = device.id AND membership.account_id = $1
          AND membership.status = 'active'
          AND (membership.expires_at IS NULL OR membership.expires_at > NOW())
         WHERE device.id = ANY($2::uuid[])`,
        [accountId, [...deviceIds]],
    )).rows.map(row => [row.id as string, row]));

    const describe = (deviceId: string) => {
        const device = devices.get(deviceId);
        const product = device ? app.catalog.getProduct(device.product_id) as any : null;
        return {
            ref: device ? { mac: device.mac, name: device.name, product_id: device.product_id } : null,
            product: product && product.catalog_revision === device?.catalog_revision ? product : null,
            accessible: Boolean(device?.accessible),
        };
    };
    const stateView = (deviceId: string, path: string, operator: Operator, value: unknown, use: 'trigger' | 'condition') => {
        const { ref, product, accessible } = describe(deviceId);
        const property = product ? findProperty(product, path, use) : null;
        return {
            kind: 'device' as const,
            device: ref,
            property: path,
            label: property?.label ?? path,
            instance_label: property?.instance_label ?? path.split('.')[1] ?? path,
            operator,
            value,
            unit: property?.unit ?? null,
            available: Boolean(accessible && property),
        };
    };

    return rows.map(row => {
        let trigger: TriggerView;
        if (row.trigger_kind === 'state') {
            trigger = {
                ...stateView(row.trigger_device_id, row.trigger_property, row.trigger_operator, row.trigger_value, 'trigger'),
                kind: 'state',
            };
        } else if (row.trigger_kind === 'event') {
            const { ref, product, accessible } = describe(row.trigger_device_id);
            const event = product ? findEvent(product, row.trigger_event) : null;
            trigger = {
                kind: 'event',
                device: ref,
                event: row.trigger_event,
                capability_id: event?.capability_id ?? null,
                event_name: event?.event_name ?? String(row.trigger_event).split('.')[1],
                instance_label: event?.instance_label ?? String(row.trigger_event).split('.')[0],
                available: Boolean(accessible && event),
            };
        } else {
            trigger = { kind: 'time', time: row.trigger_time, days: row.trigger_days };
        }
        return {
            id: row.id,
            name: row.name,
            enabled: row.enabled,
            trigger,
            conditions: (row.conditions as StoredCondition[]).map((condition): ConditionView => {
                if (!isWeatherCondition(condition)) {
                    return stateView(condition.device_id, condition.property, condition.operator, condition.value, 'condition');
                }
                const known = findWeatherCondition(condition.weather);
                return {
                    kind: 'weather',
                    device: null,
                    property: `weather.${condition.weather}`,
                    label: known?.label ?? condition.weather,
                    instance_label: 'Thời tiết',
                    operator: condition.operator,
                    value: condition.value,
                    unit: known?.kind === 'number' ? 'celsius' : null,
                    available: Boolean(known) && weatherAvailable,
                };
            }),
            window: row.active_from ? { from: row.active_from, to: row.active_to } : null,
            timezone: row.timezone,
            scene: row.scene_id ? { id: row.scene_id, name: row.scene_name } : null,
            notify_message: row.notify_message,
            cooldown_seconds: row.cooldown_seconds,
            suggestion: row.suggestion,
            next_run_at: row.next_run_at,
            last_triggered_at: row.last_triggered_at,
            last_result: row.last_result,
            last_skip_reason: row.last_skip_reason,
            last_run_id: row.last_run_id,
        };
    });
}

export async function getAutomation(app: FastifyInstance, accountId: string, automationId: string) {
    const [automation] = await listAutomations(app, accountId, automationId);
    if (!automation) throw httpError(404, 'AUTOMATION_NOT_FOUND', 'Automation not found');
    return automation;
}

// ── Saving ─────────────────────────────────────────────────────────────────

export interface ResolvedAutomation {
    input: AutomationInput;
    triggerDeviceId: string | null;
    triggerMac: string | null;
    conditions: StoredCondition[];
}

/** Checks the trigger and conditions against the caller's devices and the catalog. */
export async function resolveAutomation(
    app: FastifyInstance,
    accountId: string,
    input: AutomationInput,
): Promise<ResolvedAutomation> {
    const deviceConditions = input.conditions.filter((condition): condition is DeviceConditionInput => 'mac' in condition);
    const macs = new Set(deviceConditions.map(condition => condition.mac));
    if (input.trigger.kind !== 'time') macs.add(input.trigger.mac);
    const devices = await loadAccessibleDevices(app, [...macs], accountId);
    const productOf = (mac: string, what: string) => {
        const device = devices.get(mac);
        if (!device) throw httpError(404, 'DEVICE_NOT_FOUND', `${what}: device not found`);
        const product = app.catalog.getProduct(device.product_id) as any;
        return { device, product: product && product.catalog_revision === device.catalog_revision ? product : null };
    };

    const trigger = input.trigger;
    let triggerDeviceId: string | null = null;
    let triggerMac: string | null = null;
    if (trigger.kind === 'state') {
        const { device, product } = productOf(trigger.mac, 'Trigger');
        const property = product ? findProperty(product, trigger.property, 'trigger') : null;
        if (!property || !validComparison(property, trigger.operator, trigger.value)) {
            throw httpError(400, 'AUTOMATION_TRIGGER_INVALID', 'This state cannot start an automation');
        }
        triggerDeviceId = device.id;
        triggerMac = device.mac;
    } else if (trigger.kind === 'event') {
        const { device, product } = productOf(trigger.mac, 'Trigger');
        if (!product || !findEvent(product, trigger.event)) {
            throw httpError(400, 'AUTOMATION_TRIGGER_INVALID', 'This device does not report that event');
        }
        triggerDeviceId = device.id;
        triggerMac = device.mac;
    }

    const conditions = input.conditions.map((condition, index): StoredCondition => {
        if (!('mac' in condition)) {
            if (!weatherEnabled()) throw httpError(400, 'WEATHER_UNAVAILABLE', 'Weather is not enabled on this server');
            if (!validWeatherComparison(condition.weather, condition.operator, condition.value)) {
                throw httpError(400, 'AUTOMATION_CONDITION_INVALID', `Condition ${index + 1}: not a usable comparison`);
            }
            return { kind: 'weather', weather: condition.weather, operator: condition.operator, value: condition.value };
        }
        const { device, product } = productOf(condition.mac, `Condition ${index + 1}`);
        const property = product ? findProperty(product, condition.property, 'condition') : null;
        if (!property || !validComparison(property, condition.operator, condition.value)) {
            throw httpError(400, 'AUTOMATION_CONDITION_INVALID', `Condition ${index + 1}: not a usable comparison`);
        }
        return {
            device_id: device.id as string,
            property: condition.property,
            operator: condition.operator,
            value: condition.value,
        };
    });
    if (conditions.some(isWeatherCondition) && !(await homeLocation(app, accountId))) {
        throw httpError(400, 'WEATHER_LOCATION_REQUIRED', 'Set the home location before using the weather');
    }
    return { input, triggerDeviceId, triggerMac, conditions };
}

/** Whether a state trigger already holds (it fires only when it becomes true). */
async function holdsNow(app: FastifyInstance, resolved: ResolvedAutomation): Promise<boolean> {
    const trigger = resolved.input.trigger;
    if (trigger.kind !== 'state' || !resolved.triggerMac) return false;
    const shadow = await app.mongo.db.collection<any>(env.MONGO_DEVICE_SHADOWS_COLLECTION)
        .findOne({ _id: resolved.triggerMac }, { projection: { instances: 1, diagnostics: 1, is_online: 1 } });
    return compare(shadowValue(shadow, trigger.property), trigger.operator, trigger.value);
}

async function checkScene(app: FastifyInstance, client: PoolClient, accountId: string, sceneId: string | null) {
    if (!sceneId) return;
    const scene = await client.query(
        'SELECT id FROM scenes WHERE id = $1 AND account_id = $2 FOR SHARE',
        [sceneId, accountId],
    );
    if (!scene.rows[0]) throw httpError(404, 'SCENE_NOT_FOUND', 'Scene not found');
    // Nobody is there to type the password when an automation runs it.
    if (await sceneHasProtectedSteps(app, client, sceneId)) throw PROTECTED_SCENE();
}

function columnValues(resolved: ResolvedAutomation, matched: boolean) {
    const { input } = resolved;
    const trigger = input.trigger;
    return [
        input.name,
        input.enabled,
        trigger.kind,
        resolved.triggerDeviceId,
        trigger.kind === 'state' ? trigger.property : null,
        trigger.kind === 'state' ? trigger.operator : null,
        trigger.kind === 'state' ? JSON.stringify(trigger.value) : null,
        trigger.kind === 'event' ? trigger.event : null,
        trigger.kind === 'time' ? trigger.time : null,
        trigger.kind === 'time' ? trigger.days : null,
        input.timezone,
        JSON.stringify(resolved.conditions),
        input.window?.from ?? null,
        input.window?.to ?? null,
        input.scene_id,
        input.notify_message,
        input.cooldown_seconds,
        matched,
    ];
}

// $1..$18 in columnValues order, then next_run_at from the time trigger.
const WRITE_COLUMNS = `name, enabled, trigger_kind, trigger_device_id, trigger_property, trigger_operator,
    trigger_value, trigger_event, trigger_time, trigger_days, timezone, conditions, active_from, active_to,
    scene_id, notify_message, cooldown_seconds, trigger_matched, next_run_at`;
const WRITE_VALUES = `$1::text, $2::boolean, $3::text, $4::uuid, $5::text, $6::text, $7::jsonb, $8::text,
    $9::time, $10::smallint[], $11::text, $12::jsonb, $13::time, $14::time, $15::uuid, $16::text,
    $17::integer, $18::boolean,
    CASE WHEN $3::text = 'time' AND $2::boolean
        THEN scene_schedule_next_run($9::time, $10::smallint[], $11::text, NOW()) END`;

/** Adds an automation inside the caller's transaction (also used by suggestions). */
export async function insertAutomation(
    app: FastifyInstance,
    client: PoolClient,
    accountId: string,
    resolved: ResolvedAutomation,
    options: { suggestion?: string } = {},
): Promise<string> {
    await lockAccount(client, accountId);
    const count = await client.query('SELECT count(*)::int AS count FROM automations WHERE account_id = $1', [accountId]);
    if (count.rows[0].count >= env.MAX_AUTOMATIONS_PER_ACCOUNT) {
        throw httpError(409, 'AUTOMATION_LIMIT',
            `An account can have at most ${env.MAX_AUTOMATIONS_PER_ACCOUNT} automations`);
    }
    await assertTimezone(client, resolved.input.timezone);
    await checkScene(app, client, accountId, resolved.input.scene_id);
    const matched = await holdsNow(app, resolved);
    const inserted = await client.query(
        `INSERT INTO automations (${WRITE_COLUMNS}, account_id, suggestion)
         VALUES (${WRITE_VALUES}, $19, $20)
         RETURNING id`,
        [...columnValues(resolved, matched), accountId, options.suggestion ?? null],
    );
    return inserted.rows[0].id as string;
}

export async function createAutomation(app: FastifyInstance, accountId: string, input: AutomationInput) {
    const resolved = await resolveAutomation(app, accountId, input);
    const id = await inTransaction(app, client => insertAutomation(app, client, accountId, resolved));
    await announceChange(app, id);
    return getAutomation(app, accountId, id);
}

/** Replaces the whole definition; history (last result, last run) stays. */
export async function replaceAutomation(
    app: FastifyInstance,
    accountId: string,
    automationId: string,
    input: AutomationInput,
) {
    const resolved = await resolveAutomation(app, accountId, input);
    await inTransaction(app, async (client) => {
        await assertTimezone(client, input.timezone);
        await checkScene(app, client, accountId, input.scene_id);
        const matched = await holdsNow(app, resolved);
        const updated = await client.query(
            `UPDATE automations SET (${WRITE_COLUMNS}) = (${WRITE_VALUES})
             WHERE id = $19 AND account_id = $20
             RETURNING id`,
            [...columnValues(resolved, matched), automationId, accountId],
        );
        if (!updated.rows[0]) throw httpError(404, 'AUTOMATION_NOT_FOUND', 'Automation not found');
    });
    await announceChange(app, automationId);
    return getAutomation(app, accountId, automationId);
}

/** Turns an automation on or off. Turning it on starts from the current state. */
export async function setAutomationEnabled(
    app: FastifyInstance,
    accountId: string,
    automationId: string,
    enabled: boolean,
) {
    await inTransaction(app, async (client) => {
        const current = (await client.query(
            `SELECT automation.scene_id, automation.trigger_kind, automation.trigger_property,
                    automation.trigger_operator, automation.trigger_value, device.mac
             FROM automations AS automation
             LEFT JOIN device_metadata AS device ON device.id = automation.trigger_device_id
             WHERE automation.id = $1 AND automation.account_id = $2
             FOR UPDATE OF automation`,
            [automationId, accountId],
        )).rows[0];
        if (!current) throw httpError(404, 'AUTOMATION_NOT_FOUND', 'Automation not found');
        if (enabled) await checkScene(app, client, accountId, current.scene_id);
        let matched = false;
        if (enabled && current.trigger_kind === 'state' && current.mac) {
            const shadow = await app.mongo.db.collection<any>(env.MONGO_DEVICE_SHADOWS_COLLECTION)
                .findOne({ _id: current.mac }, { projection: { instances: 1, diagnostics: 1, is_online: 1 } });
            matched = compare(shadowValue(shadow, current.trigger_property), current.trigger_operator, current.trigger_value);
        }
        await client.query(
            `UPDATE automations
             SET enabled = $2, trigger_matched = $3,
                 next_run_at = CASE WHEN $2 AND trigger_kind = 'time'
                     THEN scene_schedule_next_run(trigger_time, trigger_days, timezone, NOW()) END
             WHERE id = $1`,
            [automationId, enabled, matched],
        );
    });
    await announceChange(app, automationId);
    return getAutomation(app, accountId, automationId);
}

export async function deleteAutomation(app: FastifyInstance, accountId: string, automationId: string) {
    const result = await app.pg.query(
        'DELETE FROM automations WHERE id = $1 AND account_id = $2 RETURNING id',
        [automationId, accountId],
    );
    if (!result.rows[0]) throw httpError(404, 'AUTOMATION_NOT_FOUND', 'Automation not found');
    await announceChange(app, automationId);
}
