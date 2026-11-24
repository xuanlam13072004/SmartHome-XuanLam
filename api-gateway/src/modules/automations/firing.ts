import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { REDIS_CHANNELS } from '../../../../shared/constants';
import { env } from '../../config/env';
import {
    type AccountNotificationRow,
    insertAccountNotification,
    publishAccountNotification,
} from '../notifications/accountNotifications';
import { advanceRun, insertRun } from '../scenes/runs';
import { skipReason } from '../scenes/schedules';
import { compareWeather, weatherValue } from '../weather/forecast';
import { readForecast } from '../weather/service';
import { compare, shadowValue } from './catalog';
import { isWeatherCondition, type StoredCondition } from './service';

/**
 * Firing an automation. Every decision happens with the automation's row
 * locked, so it acts exactly once even when several Gateway instances heard
 * the same telemetry or event:
 * - state trigger: acts only while trigger_matched is false (false → true);
 * - event trigger: acts only for an event id it has not handled;
 * - time trigger: the due row is claimed with FOR UPDATE SKIP LOCKED and its
 *   next_run_at moves on in the same transaction (like scene schedules).
 * Then: account not locked by the administrator → trigger device still
 * accessible → cooldown over (device triggers) →
 * active window → conditions on the devices' current state and on the stored
 * forecast of the account's home (weather unknown = not met, recorded as
 * last_skip_reason 'weather_unavailable') → run the scene (insertRun, trigger
 * 'automation') and/or insert the notification. The outcome is recorded in
 * last_result; runs and notifications go out after COMMIT.
 */

const MISSED_AFTER_MINUTES = 15;

const FIRE_COLUMNS = `automation.id, automation.account_id, automation.name, automation.trigger_kind,
    EXISTS (SELECT 1 FROM accounts AS account
            WHERE account.id = automation.account_id AND account.status = 'active') AS account_active,
    automation.trigger_matched, automation.last_event_id, automation.conditions, automation.scene_id,
    automation.notify_message,
    automation_window_open(automation.active_from, automation.active_to, automation.timezone, NOW()) AS window_open,
    (automation.last_acted_at IS NULL
        OR automation.last_acted_at <= NOW() - make_interval(secs => automation.cooldown_seconds)) AS cooled,
    (automation.trigger_device_id IS NULL OR EXISTS (
        SELECT 1 FROM device_memberships AS membership
        JOIN device_metadata AS device ON device.id = membership.device_id AND device.is_active = true
        WHERE membership.device_id = automation.trigger_device_id
          AND membership.account_id = automation.account_id
          AND membership.status = 'active'
          AND (membership.expires_at IS NULL OR membership.expires_at > NOW())
    )) AS available`;

interface FireRow {
    id: string;
    account_id: string;
    /** False while the administrator has locked the account: its smart features pause. */
    account_active: boolean;
    name: string;
    trigger_kind: 'state' | 'event' | 'time';
    trigger_matched: boolean;
    last_event_id: string | null;
    conditions: StoredCondition[];
    scene_id: string | null;
    notify_message: string | null;
    window_open: boolean;
    cooled: boolean;
    available: boolean;
}

interface Outcome {
    /** Recorded in last_result; null records nothing (cooldown). */
    result: string | null;
    /** Recorded in last_skip_reason with a result: why nothing ran besides the devices. */
    skipReason?: string | null;
    acted: boolean;
    runId: string | null;
    notification: AccountNotificationRow | null;
}

const NOTHING: Outcome = { result: null, acted: false, runId: null, notification: null };

/**
 * Whether all conditions hold: device ones on the devices' current state (a
 * device the account lost access to fails), weather ones on the stored
 * forecast of the account's home ('weather_unavailable' when it is unknown).
 */
async function conditionsHold(app: FastifyInstance, client: PoolClient, row: FireRow): Promise<true | false | 'weather_unavailable'> {
    const weather = row.conditions.filter(isWeatherCondition);
    const devicesOnly = row.conditions.filter(condition => !isWeatherCondition(condition)) as
        Array<Exclude<StoredCondition, { kind: 'weather' }>>;
    if (devicesOnly.length > 0 && !(await deviceConditionsHold(app, client, row.account_id, devicesOnly))) return false;
    if (weather.length === 0) return true;
    const home = (await client.query(
        'SELECT home_latitude, home_longitude, home_place FROM account_preferences WHERE account_id = $1',
        [row.account_id],
    )).rows[0];
    const location = home?.home_latitude === null || home?.home_latitude === undefined ? null
        : { latitude: Number(home.home_latitude), longitude: Number(home.home_longitude), place: home.home_place };
    const now = new Date();
    const forecast = await readForecast(app, location, now);
    const values = weather.map(condition => weatherValue(forecast, condition.weather, now));
    if (values.some(value => value === undefined)) return 'weather_unavailable';
    return weather.every((condition, index) => compareWeather(values[index], condition.operator, condition.value));
}

async function deviceConditionsHold(
    app: FastifyInstance,
    client: PoolClient,
    accountId: string,
    conditions: Array<Exclude<StoredCondition, { kind: 'weather' }>>,
): Promise<boolean> {
    const devices = await client.query(
        `SELECT device.id, device.mac FROM device_metadata AS device
         JOIN device_memberships AS membership
           ON membership.device_id = device.id AND membership.account_id = $1
          AND membership.status = 'active'
          AND (membership.expires_at IS NULL OR membership.expires_at > NOW())
         WHERE device.id = ANY($2::uuid[]) AND device.is_active = true`,
        [accountId, conditions.map(condition => condition.device_id)],
    );
    const macs = new Map(devices.rows.map(device => [device.id as string, device.mac as string]));
    if (conditions.some(condition => !macs.has(condition.device_id))) return false;
    const shadows = await app.mongo.db.collection<any>(env.MONGO_DEVICE_SHADOWS_COLLECTION)
        .find({ _id: { $in: [...new Set(macs.values())] } }, { projection: { instances: 1, diagnostics: 1, is_online: 1 } })
        .toArray();
    const byMac = new Map(shadows.map(shadow => [String(shadow._id), shadow]));
    return conditions.every(condition => compare(
        shadowValue(byMac.get(macs.get(condition.device_id)!), condition.property),
        condition.operator,
        condition.value,
    ));
}

async function act(app: FastifyInstance, client: PoolClient, row: FireRow, respectCooldown: boolean): Promise<Outcome> {
    // Paused (account locked): nothing runs and nothing is shown; the trigger
    // still moves on (next time, state edge, event id) so unlocking does not
    // replay what happened meanwhile.
    if (!row.account_active) return NOTHING;
    if (!row.available) return { ...NOTHING, result: 'unavailable' };
    if (respectCooldown && !row.cooled) return NOTHING;
    if (!row.window_open) return { ...NOTHING, result: 'skipped_conditions' };
    const held = await conditionsHold(app, client, row);
    if (held !== true) {
        return { ...NOTHING, result: 'skipped_conditions', skipReason: held === 'weather_unavailable' ? held : null };
    }
    let result: string | null = null;
    let runId: string | null = null;
    if (row.scene_id) {
        await client.query('SAVEPOINT automation_run');
        try {
            runId = await insertRun(app, client, {
                accountId: row.account_id,
                sceneId: row.scene_id,
                trigger: 'automation',
                reauthenticated: false,
                automationId: row.id,
            });
            await client.query('RELEASE SAVEPOINT automation_run');
            result = 'started';
        } catch (error: any) {
            await client.query('ROLLBACK TO SAVEPOINT automation_run');
            result = skipReason(error) ?? (error?.code === 'SCENE_NOT_FOUND' ? 'no_action' : null);
            if (!result) throw error;
        }
    }
    let notification: AccountNotificationRow | null = null;
    if (row.notify_message) {
        notification = await insertAccountNotification(client, {
            accountId: row.account_id,
            automationId: row.id,
            title: row.name,
            body: row.notify_message,
        });
        result ??= 'notified';
    }
    return { result: result ?? 'no_action', acted: Boolean(runId || notification), runId, notification };
}

const RECORD = `UPDATE automations
    SET trigger_matched = CASE WHEN trigger_kind = 'state' THEN true ELSE trigger_matched END,
        last_event_id = COALESCE($2, last_event_id),
        last_triggered_at = CASE WHEN $3::text IS NULL THEN last_triggered_at ELSE NOW() END,
        last_result = COALESCE($3, last_result),
        last_skip_reason = CASE WHEN $3::text IS NULL THEN last_skip_reason ELSE $6::text END,
        last_acted_at = CASE WHEN $4 THEN NOW() ELSE last_acted_at END,
        last_run_id = COALESCE($5, last_run_id),
        next_run_at = CASE WHEN trigger_kind = 'time'
            THEN scene_schedule_next_run(trigger_time, trigger_days, timezone, NOW()) ELSE next_run_at END
    WHERE id = $1
    RETURNING id, account_id, last_triggered_at, last_result, last_skip_reason, last_run_id, next_run_at`;

interface Fired {
    accountId: string;
    status: Record<string, unknown>;
    outcome: Outcome;
}

async function record(client: PoolClient, row: FireRow, outcome: Outcome, eventId: string | null): Promise<Fired> {
    const updated = (await client.query(RECORD, [
        row.id, eventId, outcome.result, outcome.acted, outcome.runId, outcome.skipReason ?? null,
    ])).rows[0];
    return {
        accountId: row.account_id,
        status: {
            automation_id: updated.id,
            last_triggered_at: updated.last_triggered_at,
            last_result: updated.last_result,
            last_skip_reason: updated.last_skip_reason,
            last_run_id: updated.last_run_id,
            next_run_at: updated.next_run_at,
        },
        outcome,
    };
}

/** After COMMIT: first scene steps, the notification, and the card's new status. */
async function deliver(app: FastifyInstance, fired: Fired) {
    if (fired.outcome.runId) await advanceRun(app, fired.outcome.runId);
    if (fired.outcome.notification) {
        await publishAccountNotification(app, fired.accountId, fired.outcome.notification);
    }
    if (fired.outcome.result) {
        try {
            await app.redis.publish(REDIS_CHANNELS.ACCOUNT_EVENT, JSON.stringify({
                account_id: fired.accountId,
                event: 'automation_fired',
                data: fired.status,
            }));
        } catch (error) {
            app.log.warn({ error }, 'Failed to publish an automation status');
        }
    }
}

/**
 * A device trigger happened: the state comparison became true (no eventId)
 * or the device reported the event [eventId]. Returns the recorded result
 * (null when another instance handled it or nothing was recorded).
 */
export async function fireDeviceTrigger(
    app: FastifyInstance,
    automationId: string,
    cause: { eventId?: string } = {},
): Promise<string | null> {
    const client = await app.pg.connect();
    let fired: Fired | null = null;
    try {
        await client.query('BEGIN');
        const row = (await client.query(
            `SELECT ${FIRE_COLUMNS} FROM automations AS automation
             WHERE automation.id = $1 AND automation.enabled AND automation.trigger_kind IN ('state', 'event')
             FOR UPDATE OF automation`,
            [automationId],
        )).rows[0] as FireRow | undefined;
        const duplicate = !row
            || (row.trigger_kind === 'state' && (cause.eventId !== undefined || row.trigger_matched))
            || (row.trigger_kind === 'event' && (!cause.eventId || row.last_event_id === cause.eventId));
        if (duplicate) {
            await client.query('ROLLBACK');
            return null;
        }
        fired = await record(client, row, await act(app, client, row, true), cause.eventId ?? null);
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
    await deliver(app, fired);
    return fired.outcome.result;
}

/** The state comparison stopped holding: the next false → true fires again. */
export async function releaseStateTrigger(app: FastifyInstance, automationId: string) {
    await app.pg.query(
        `UPDATE automations SET trigger_matched = false
         WHERE id = $1 AND trigger_kind = 'state' AND trigger_matched`,
        [automationId],
    );
}

/**
 * Fires up to [limit] due time triggers and returns how many were handled.
 * An occurrence more than MISSED_AFTER_MINUTES late is recorded as missed.
 */
export async function runDueAutomations(app: FastifyInstance, limit = 50): Promise<number> {
    const client = await app.pg.connect();
    const fired: Fired[] = [];
    let handled = 0;
    try {
        await client.query('BEGIN');
        const due = await client.query(
            `SELECT ${FIRE_COLUMNS},
                    automation.next_run_at < NOW() - make_interval(mins => $2) AS missed
             FROM automations AS automation
             WHERE automation.next_run_at <= NOW()
             ORDER BY automation.next_run_at
             LIMIT $1
             FOR UPDATE OF automation SKIP LOCKED`,
            [limit, MISSED_AFTER_MINUTES],
        );
        handled = due.rows.length;
        for (const row of due.rows as Array<FireRow & { missed: boolean }>) {
            const outcome = row.missed ? { ...NOTHING, result: 'missed' } : await act(app, client, row, false);
            fired.push(await record(client, row, outcome, null));
        }
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
    for (const item of fired) await deliver(app, item);
    return handled;
}
