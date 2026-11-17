import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { env } from '../../config/env';
import { httpError } from '../../utils/httpError';
import { isProtectedOperation } from './actions';
import { advanceRun, insertRun } from './runs';

/**
 * Scene schedules ("Hẹn giờ"): run a scene at a local time on chosen weekdays.
 *
 * PostgreSQL computes every next occurrence (scene_schedule_next_run) in the
 * schedule's own time zone. The scene runner fires due schedules in batches:
 * locking them (FOR UPDATE SKIP LOCKED), creating the run and moving
 * next_run_at forward happen in one transaction, so each occurrence fires
 * exactly once even with several Gateway instances. An occurrence more than
 * MISSED_AFTER_MINUTES late (the Gateway was down) is recorded as missed, not
 * run late: nobody wants the garden watered at noon instead of 6:00.
 * Scenes with protected steps (password needed) cannot be scheduled.
 */

const MISSED_AFTER_MINUTES = 15;

export interface SceneScheduleView {
    id: string;
    scene_id: string;
    time: string;
    days: number[];
    timezone: string;
    enabled: boolean;
    next_run_at: string | null;
    last_fired_at: string | null;
    last_result: string | null;
    last_run_id: string | null;
}

const SCHEDULE_COLUMNS = `id, scene_id, to_char(local_time, 'HH24:MI') AS time, days, timezone, enabled,
    next_run_at, last_fired_at, last_result, last_run_id`;

async function inTransaction<T>(app: FastifyInstance, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await app.pg.connect();
    try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
    } catch (error: any) {
        await client.query('ROLLBACK');
        if (error?.code === '23505') {
            throw httpError(409, 'SCENE_SCHEDULE_DUPLICATE', 'This scene already runs at that time on those days');
        }
        throw error;
    } finally {
        client.release();
    }
}

export async function assertTimezone(client: PoolClient, timezone: string) {
    try {
        await client.query('SELECT NOW() AT TIME ZONE $1', [timezone]);
    } catch {
        throw httpError(400, 'INVALID_TIMEZONE', 'Unknown time zone');
    }
}

/** True when a step of [sceneId] needs the password (cannot run unattended). */
export async function sceneHasProtectedSteps(app: FastifyInstance, client: PoolClient, sceneId: string) {
    const steps = await client.query(
        `SELECT step.instance_id, step.operation_name, device.product_id
         FROM scene_steps AS step JOIN device_metadata AS device ON device.id = step.device_id
         WHERE step.scene_id = $1`,
        [sceneId],
    );
    return steps.rows.some(step => {
        const operation = app.catalog.getOperation(step.product_id, step.instance_id, step.operation_name);
        return operation ? isProtectedOperation(operation) : false;
    });
}

function protectedError() {
    return httpError(400, 'SCENE_PROTECTED_STEPS', 'A scene with steps that need the password cannot be scheduled');
}

/** Schedules of the given scenes, by scene. */
export async function loadSchedules(app: FastifyInstance, sceneIds: string[]) {
    const result = sceneIds.length === 0 ? { rows: [] as SceneScheduleView[] } : await app.pg.query(
        `SELECT ${SCHEDULE_COLUMNS} FROM scene_schedules
         WHERE scene_id = ANY($1::uuid[]) ORDER BY local_time, created_at`,
        [sceneIds],
    );
    const byScene = new Map<string, SceneScheduleView[]>();
    for (const row of result.rows as SceneScheduleView[]) {
        const list = byScene.get(row.scene_id) ?? [];
        list.push(row);
        byScene.set(row.scene_id, list);
    }
    return byScene;
}

export async function createSchedule(
    app: FastifyInstance,
    accountId: string,
    sceneId: string,
    input: { time: string; days: number[]; timezone: string },
): Promise<SceneScheduleView> {
    return inTransaction(app, async (client) => {
        // Locking the scene serialises the per-scene limit.
        const scene = await client.query(
            'SELECT id FROM scenes WHERE id = $1 AND account_id = $2 FOR UPDATE',
            [sceneId, accountId],
        );
        if (!scene.rows[0]) throw httpError(404, 'SCENE_NOT_FOUND', 'Scene not found');
        await assertTimezone(client, input.timezone);
        if (await sceneHasProtectedSteps(app, client, sceneId)) throw protectedError();
        const count = await client.query('SELECT count(*)::int AS count FROM scene_schedules WHERE scene_id = $1', [sceneId]);
        if (count.rows[0].count >= env.MAX_SCHEDULES_PER_SCENE) {
            throw httpError(409, 'SCENE_SCHEDULE_LIMIT', `A scene can have at most ${env.MAX_SCHEDULES_PER_SCENE} schedules`);
        }
        const inserted = await client.query(
            `INSERT INTO scene_schedules (scene_id, account_id, local_time, days, timezone, next_run_at)
             VALUES ($1, $2, $3::time, $4::smallint[], $5,
                     scene_schedule_next_run($3::time, $4::smallint[], $5, NOW()))
             RETURNING ${SCHEDULE_COLUMNS}`,
            [sceneId, accountId, input.time, input.days, input.timezone],
        );
        return inserted.rows[0];
    });
}

/** Changes time, days or time zone, or turns a schedule on or off. */
export async function updateSchedule(
    app: FastifyInstance,
    accountId: string,
    scheduleId: string,
    input: { time?: string; days?: number[]; timezone?: string; enabled?: boolean },
): Promise<SceneScheduleView> {
    return inTransaction(app, async (client) => {
        const current = await client.query(
            `SELECT scene_id, to_char(local_time, 'HH24:MI') AS time, days, timezone, enabled
             FROM scene_schedules WHERE id = $1 AND account_id = $2 FOR UPDATE`,
            [scheduleId, accountId],
        );
        const schedule = current.rows[0];
        if (!schedule) throw httpError(404, 'SCENE_SCHEDULE_NOT_FOUND', 'Schedule not found');
        const next = {
            time: input.time ?? schedule.time,
            days: input.days ?? schedule.days,
            timezone: input.timezone ?? schedule.timezone,
            enabled: input.enabled ?? schedule.enabled,
        };
        if (input.timezone) await assertTimezone(client, next.timezone);
        if (next.enabled && await sceneHasProtectedSteps(app, client, schedule.scene_id)) throw protectedError();
        const updated = await client.query(
            `UPDATE scene_schedules
             SET local_time = $2::time, days = $3::smallint[], timezone = $4, enabled = $5,
                 next_run_at = CASE WHEN $5 THEN scene_schedule_next_run($2::time, $3::smallint[], $4, NOW()) END
             WHERE id = $1
             RETURNING ${SCHEDULE_COLUMNS}`,
            [scheduleId, next.time, next.days, next.timezone, next.enabled],
        );
        return updated.rows[0];
    });
}

export async function deleteSchedule(app: FastifyInstance, accountId: string, scheduleId: string) {
    const result = await app.pg.query(
        'DELETE FROM scene_schedules WHERE id = $1 AND account_id = $2 RETURNING id',
        [scheduleId, accountId],
    );
    if (!result.rows[0]) throw httpError(404, 'SCENE_SCHEDULE_NOT_FOUND', 'Schedule not found');
}

/** Why a due occurrence did not start a run, from insertRun's error. */
export function skipReason(error: any): string | null {
    if (error?.code === '23505' || error?.code === 'SCENE_ALREADY_RUNNING') return 'skipped_running';
    if (error?.code === 'REAUTHENTICATION_REQUIRED') return 'skipped_protected';
    if (error?.code === 'SCENE_EMPTY') return 'skipped_empty';
    return null;
}

/**
 * Fires up to [limit] due schedules and returns how many were handled. Each
 * one either starts a run, records why it was skipped, or records a missed
 * occurrence; in every case next_run_at moves to the next occurrence after now.
 */
export async function runDueSchedules(app: FastifyInstance, limit = 50): Promise<number> {
    const client = await app.pg.connect();
    const started: string[] = [];
    let handled = 0;
    try {
        await client.query('BEGIN');
        const due = await client.query(
            `SELECT id, scene_id, account_id,
                    next_run_at < NOW() - make_interval(mins => $2) AS missed
             FROM scene_schedules
             WHERE enabled AND next_run_at <= NOW()
             ORDER BY next_run_at
             LIMIT $1
             FOR UPDATE SKIP LOCKED`,
            [limit, MISSED_AFTER_MINUTES],
        );
        handled = due.rows.length;
        for (const schedule of due.rows) {
            let result = 'missed';
            let runId: string | null = null;
            if (!schedule.missed) {
                await client.query('SAVEPOINT fire');
                try {
                    runId = await insertRun(app, client, {
                        accountId: schedule.account_id,
                        sceneId: schedule.scene_id,
                        trigger: 'schedule',
                        reauthenticated: false,
                    });
                    await client.query('RELEASE SAVEPOINT fire');
                    result = 'started';
                    started.push(runId);
                } catch (error) {
                    await client.query('ROLLBACK TO SAVEPOINT fire');
                    const reason = skipReason(error);
                    if (!reason) throw error;
                    result = reason;
                }
            }
            await client.query(
                `UPDATE scene_schedules
                 SET next_run_at = scene_schedule_next_run(local_time, days, timezone, NOW()),
                     last_fired_at = NOW(), last_result = $2, last_run_id = COALESCE($3, last_run_id)
                 WHERE id = $1`,
                [schedule.id, result, runId],
            );
        }
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
    // Committed: send the first steps (if this process stops here, the runner
    // picks the runs up when their short lease ends).
    for (const runId of started) await advanceRun(app, runId);
    return handled;
}
