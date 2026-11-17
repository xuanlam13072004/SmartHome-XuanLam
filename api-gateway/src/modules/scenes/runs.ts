import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { REDIS_CHANNELS } from '../../../../shared/constants';
import { env } from '../../config/env';
import { httpError } from '../../utils/httpError';
import { createDeviceOperation } from '../device/service';
import { isProtectedOperation, operationLabel } from './actions';

/**
 * Scene runs.
 *
 * A run copies the scene's steps when it starts. Each step becomes a normal
 * device operation (same permission checks as a tap in the app) whose
 * idempotency key is `scene-run:<run>:<step>`, so a step is never sent twice.
 *
 * Who moves a run forward:
 * - the request that starts it sends the first steps right away;
 * - the runner (workers/sceneRunner.ts) claims runs whose next step is due
 *   (FOR UPDATE SKIP LOCKED + a short lease on next_step_at, safe with several
 *   Gateway instances) and, every second, copies finished device operations
 *   into their steps and closes runs with nothing left to wait for.
 * A failed step does not stop the following ones ("Ra khỏi nhà" still closes
 * the roof when the door is offline). Final status: succeeded / partial / failed.
 */

const CLAIM_LEASE_SECONDS = 30;
const TERMINAL_OPERATIONS = ['succeeded', 'rejected', 'failed', 'timed_out', 'cancelled'];

export interface SceneRunStepView {
    index: number;
    device_name: string;
    device_mac: string | null;
    label: string;
    input: Record<string, unknown>;
    delay_seconds: number;
    status: 'pending' | 'dispatched' | 'succeeded' | 'failed';
    reason_code: string | null;
}

export interface SceneRunView {
    id: string;
    scene_id: string | null;
    scene_name: string;
    trigger: string;
    /** The automation that started it ("Tự động: …"), while it exists. */
    automation: { id: string; name: string } | null;
    status: 'running' | 'succeeded' | 'partial' | 'failed';
    started_at: string;
    finished_at: string | null;
    steps: SceneRunStepView[];
}

// ── Views ──────────────────────────────────────────────────────────────────

async function loadRunViews(db: Pool, runIds: string[]): Promise<Map<string, SceneRunView>> {
    if (runIds.length === 0) return new Map();
    const runs = await db.query(
        `SELECT run.id, run.scene_id, run.scene_name, run.trigger, run.status, run.started_at, run.finished_at,
                automation.id AS automation_id, automation.name AS automation_name
         FROM scene_runs AS run
         LEFT JOIN automations AS automation ON automation.id = run.automation_id
         WHERE run.id = ANY($1::uuid[])`,
        [runIds],
    );
    const steps = await db.query(
        `SELECT step.run_id, step.step_index, step.device_name, device.mac AS device_mac,
                step.operation_label, step.input, step.delay_seconds, step.status, step.reason_code
         FROM scene_run_steps AS step
         LEFT JOIN device_metadata AS device ON device.id = step.device_id
         WHERE step.run_id = ANY($1::uuid[])
         ORDER BY step.run_id, step.step_index`,
        [runIds],
    );
    const views = new Map<string, SceneRunView>();
    for (const { automation_id: automationId, automation_name: automationName, ...run } of runs.rows) {
        views.set(run.id, {
            ...run,
            automation: automationId ? { id: automationId, name: automationName } : null,
            steps: [],
        });
    }
    for (const step of steps.rows) {
        views.get(step.run_id)?.steps.push({
            index: step.step_index,
            device_name: step.device_name,
            device_mac: step.device_mac,
            label: step.operation_label,
            input: step.input,
            delay_seconds: step.delay_seconds,
            status: step.status,
            reason_code: step.reason_code,
        });
    }
    return views;
}

/** Pushes the run's current state to the account's open apps (no-op when none). */
async function publishRunUpdate(app: FastifyInstance, runId: string) {
    try {
        const run = (await loadRunViews(app.pg, [runId])).get(runId);
        if (!run) return;
        const owner = await app.pg.query('SELECT account_id FROM scene_runs WHERE id = $1', [runId]);
        if (!owner.rows[0]) return;
        await app.redis.publish(REDIS_CHANNELS.ACCOUNT_EVENT, JSON.stringify({
            account_id: owner.rows[0].account_id,
            event: 'scene_run_updated',
            data: { run },
        }));
    } catch (error) {
        app.log.warn({ error, runId }, 'Failed to publish a scene run update');
    }
}

// ── Starting and advancing ────────────────────────────────────────────────

/**
 * Creates a run of [sceneId] inside the caller's transaction and returns its
 * id; the caller then calls advanceRun after COMMIT. The run is created
 * claimed (a short lease on next_step_at), so the runner only picks it up if
 * the caller never gets to send its first steps. A scene with a protected step
 * (an operation the app confirms, e.g. unlocking a door) needs a fresh password
 * confirmation. A second run while one is in progress violates
 * uq_scene_runs_one_running (23505).
 */
export async function insertRun(
    app: FastifyInstance,
    client: PoolClient,
    options: {
        accountId: string;
        sceneId: string;
        trigger: 'manual' | 'schedule' | 'automation';
        reauthenticated: boolean;
        automationId?: string;
    },
): Promise<string> {
    const scene = await client.query(
        'SELECT id, name FROM scenes WHERE id = $1 AND account_id = $2',
        [options.sceneId, options.accountId],
    );
    if (!scene.rows[0]) throw httpError(404, 'SCENE_NOT_FOUND', 'Scene not found');
    const steps = await client.query(
        `SELECT step.device_id, step.instance_id, step.operation_name, step.input, step.delay_seconds,
                device.name AS device_name, device.product_id
         FROM scene_steps AS step
         JOIN device_metadata AS device ON device.id = step.device_id
         WHERE step.scene_id = $1
         ORDER BY step.step_index`,
        [options.sceneId],
    );
    if (steps.rows.length === 0) throw httpError(409, 'SCENE_EMPTY', 'This scene has no steps');
    const operations = steps.rows.map(step => app.catalog.getOperation(
        step.product_id, step.instance_id, step.operation_name,
    ) as Record<string, any> | null);
    if (operations.some(operation => operation && isProtectedOperation(operation)) && !options.reauthenticated) {
        throw httpError(403, 'REAUTHENTICATION_REQUIRED', 'This scene needs the account password');
    }
    const inserted = await client.query(
        `INSERT INTO scene_runs
            (account_id, scene_id, scene_name, trigger, reauthenticated, automation_id, next_step_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW() + make_interval(secs => $7))
         RETURNING id`,
        [options.accountId, options.sceneId, scene.rows[0].name, options.trigger,
            options.reauthenticated, options.automationId ?? null, CLAIM_LEASE_SECONDS],
    );
    const runId = inserted.rows[0].id as string;
    await client.query(
        `INSERT INTO scene_run_steps
            (run_id, step_index, device_id, device_name, instance_id, operation_name,
             operation_label, input, delay_seconds)
         SELECT $1, step.step_index, step.device_id, step.device_name, step.instance_id,
                step.operation_name, step.operation_label, step.input, step.delay_seconds
         FROM jsonb_to_recordset($2::jsonb)
              AS step(step_index smallint, device_id uuid, device_name text, instance_id text,
                      operation_name text, operation_label text, input jsonb, delay_seconds integer)`,
        [runId, JSON.stringify(steps.rows.map((step, index) => ({
            step_index: index,
            device_id: step.device_id,
            device_name: step.device_name,
            instance_id: step.instance_id,
            operation_name: step.operation_name,
            operation_label: operations[index]
                ? operationLabel(operations[index]!, step.operation_name)
                : step.operation_name,
            input: step.input,
            delay_seconds: index === 0 ? 0 : step.delay_seconds,
        })))],
    );
    return runId;
}

/** Starts [sceneId] now (the "Chạy" button) and sends its first steps. */
export async function startRun(
    app: FastifyInstance,
    accountId: string,
    sceneId: string,
    options: { reauthenticated: boolean },
): Promise<SceneRunView> {
    const client = await app.pg.connect();
    let runId: string;
    try {
        await client.query('BEGIN');
        runId = await insertRun(app, client, {
            accountId, sceneId, trigger: 'manual', reauthenticated: options.reauthenticated,
        });
        await client.query('COMMIT');
    } catch (error: any) {
        await client.query('ROLLBACK');
        if (error?.code === '23505') {
            throw httpError(409, 'SCENE_ALREADY_RUNNING', 'This scene is already running');
        }
        throw error;
    } finally {
        client.release();
    }
    await advanceRun(app, runId);
    return getRun(app, accountId, runId);
}

/** Sends one pending step; a step that cannot be sent fails with the reason. */
async function dispatchStep(
    app: FastifyInstance,
    run: { id: string; account_id: string; reauthenticated: boolean },
    step: any,
) {
    if (step.status !== 'pending') return; // sent before a restart
    try {
        if (!step.mac) throw httpError(404, 'DEVICE_NOT_FOUND', 'The device was removed');
        const result = await createDeviceOperation(app, {
            mac: step.mac,
            instance_id: step.instance_id,
            operation_name: step.operation_name,
            input: step.input,
            idempotency_key: `scene-run:${run.id}:${step.step_index}`,
            reauthenticated: run.reauthenticated,
        }, run.account_id);
        await app.pg.query(
            `UPDATE scene_run_steps SET status = 'dispatched', operation_id = $3, dispatched_at = NOW()
             WHERE run_id = $1 AND step_index = $2 AND status = 'pending'`,
            [run.id, step.step_index, result.operation_id],
        );
    } catch (error: any) {
        const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.code)
            ? error.code
            : 'SCENE_STEP_FAILED';
        if (!error?.statusCode) app.log.warn({ error, runId: run.id }, 'A scene step failed unexpectedly');
        await app.pg.query(
            `UPDATE scene_run_steps SET status = 'failed', reason_code = $3, completed_at = NOW()
             WHERE run_id = $1 AND step_index = $2 AND status = 'pending'`,
            [run.id, step.step_index, code],
        );
    }
}

/**
 * Sends every step that is due, stopping at the next step with a delay.
 * The caller holds the run's claim.
 */
export async function advanceRun(app: FastifyInstance, runId: string) {
    const runResult = await app.pg.query(
        `SELECT id, account_id, reauthenticated, next_step_index FROM scene_runs
         WHERE id = $1 AND status = 'running'`,
        [runId],
    );
    const run = runResult.rows[0];
    if (!run) return;
    const steps = (await app.pg.query(
        `SELECT step.step_index, step.instance_id, step.operation_name, step.input,
                step.delay_seconds, step.status, device.mac
         FROM scene_run_steps AS step
         LEFT JOIN device_metadata AS device ON device.id = step.device_id
         WHERE step.run_id = $1
         ORDER BY step.step_index`,
        [runId],
    )).rows;

    let index = run.next_step_index as number;
    while (index < steps.length) {
        await dispatchStep(app, run, steps[index]);
        index += 1;
        const next = steps[index];
        if (next && next.delay_seconds > 0) {
            await app.pg.query(
                `UPDATE scene_runs SET next_step_index = $2, next_step_at = NOW() + make_interval(secs => $3)
                 WHERE id = $1 AND status = 'running'`,
                [runId, index, next.delay_seconds],
            );
            await publishRunUpdate(app, runId);
            return;
        }
    }
    await app.pg.query(
        `UPDATE scene_runs SET next_step_index = $2, next_step_at = NULL
         WHERE id = $1 AND status = 'running'`,
        [runId, index],
    );
    await finalizeRun(app.pg, runId);
    await publishRunUpdate(app, runId);
}

/**
 * Closes a run once every step is sent and none is waiting for its device.
 * Step changes are committed before this runs, so whichever caller comes last
 * sees them all; the row lock makes a second call a no-op.
 */
async function finalizeRun(db: Pool, runId: string) {
    await db.query(
        `UPDATE scene_runs AS run
         SET status = CASE
                 WHEN summary.succeeded = summary.total THEN 'succeeded'
                 WHEN summary.succeeded = 0 THEN 'failed'
                 ELSE 'partial'
             END,
             finished_at = NOW()
         FROM (
             SELECT count(*) AS total,
                    count(*) FILTER (WHERE status = 'succeeded') AS succeeded,
                    count(*) FILTER (WHERE status IN ('pending', 'dispatched')) AS open
             FROM scene_run_steps WHERE run_id = $1
         ) AS summary
         WHERE run.id = $1 AND run.status = 'running' AND run.next_step_at IS NULL
           AND summary.open = 0`,
        [runId],
    );
}

// ── Runner work ────────────────────────────────────────────────────────────

/** Claims runs whose next step is due and moves them forward. Returns how many. */
export async function runDueSteps(app: FastifyInstance, limit = 50): Promise<number> {
    const claimed = await app.pg.query(
        `UPDATE scene_runs SET next_step_at = NOW() + make_interval(secs => $2)
         WHERE id IN (
             SELECT id FROM scene_runs
             WHERE status = 'running' AND next_step_at <= NOW()
             ORDER BY next_step_at
             LIMIT $1
             FOR UPDATE SKIP LOCKED
         )
         RETURNING id`,
        [limit, CLAIM_LEASE_SECONDS],
    );
    for (const row of claimed.rows) await advanceRun(app, row.id);
    return claimed.rows.length;
}

/**
 * Copies finished device operations into their steps, fails steps whose
 * device was removed meanwhile, closes runs with nothing left to wait for,
 * and tells the apps. Returns the runs that changed.
 */
export async function reconcileRuns(app: FastifyInstance): Promise<string[]> {
    const finished = await app.pg.query(
        `WITH done AS (
             SELECT step.run_id, step.step_index, operation.status, operation.reason_code
             FROM scene_run_steps AS step
             JOIN device_operations AS operation ON operation.id = step.operation_id
             WHERE step.status = 'dispatched' AND operation.status = ANY($1::text[])
             LIMIT 500
         )
         UPDATE scene_run_steps AS step
         SET status = CASE WHEN done.status = 'succeeded' THEN 'succeeded' ELSE 'failed' END,
             reason_code = CASE WHEN done.status = 'succeeded' THEN NULL
                                ELSE COALESCE(done.reason_code, 'OPERATION_' || upper(done.status)) END,
             completed_at = NOW()
         FROM done
         WHERE step.run_id = done.run_id AND step.step_index = done.step_index
           AND step.status = 'dispatched'
         RETURNING step.run_id`,
        [TERMINAL_OPERATIONS],
    );
    const orphaned = await app.pg.query(
        `UPDATE scene_run_steps SET status = 'failed', reason_code = 'DEVICE_REMOVED', completed_at = NOW()
         WHERE status = 'dispatched' AND operation_id IS NULL
         RETURNING run_id`,
    );
    const settled = await app.pg.query(
        `SELECT run.id AS run_id FROM scene_runs AS run
         WHERE run.status = 'running' AND run.next_step_at IS NULL
           AND NOT EXISTS (
               SELECT 1 FROM scene_run_steps AS step
               WHERE step.run_id = run.id AND step.status IN ('pending', 'dispatched')
           )
         LIMIT 100`,
    );
    const runIds = [...new Set([...finished.rows, ...orphaned.rows, ...settled.rows].map(row => row.run_id as string))];
    for (const runId of runIds) {
        await finalizeRun(app.pg, runId);
        await publishRunUpdate(app, runId);
    }
    return runIds;
}

/** Deletes finished runs older than SCENE_RUN_RETENTION_DAYS, a batch at a time. */
export async function purgeOldRuns(app: FastifyInstance): Promise<number> {
    const result = await app.pg.query(
        `DELETE FROM scene_runs WHERE id IN (
             SELECT id FROM scene_runs
             WHERE finished_at < NOW() - make_interval(days => $1)
             LIMIT 1000
         )`,
        [env.SCENE_RUN_RETENTION_DAYS],
    );
    return result.rowCount ?? 0;
}

// ── History ───────────────────────────────────────────────────────────────

function encodeCursor(time: string, id: string) {
    return Buffer.from(JSON.stringify({ t: time, i: id }), 'utf8').toString('base64url');
}

function decodeCursor(value: string): { t: string; i: string } {
    try {
        const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
        if (typeof cursor?.t === 'string' && cursor.t.length <= 64
            && typeof cursor?.i === 'string' && /^[0-9a-f-]{36}$/.test(cursor.i)) {
            return cursor;
        }
    } catch {
        // fall through
    }
    throw httpError(400, 'INVALID_CURSOR', 'Invalid page cursor');
}

/** Newest first, keyset paged; optionally one scene only. */
export async function listRuns(
    app: FastifyInstance,
    accountId: string,
    options: { sceneId?: string; before?: string; limit: number },
) {
    const cursor = options.before ? decodeCursor(options.before) : null;
    const result = await app.pg.query(
        `SELECT id, started_at::text AS cursor_time FROM scene_runs
         WHERE account_id = $1
           AND ($2::uuid IS NULL OR scene_id = $2)
           AND ($3::timestamptz IS NULL OR (started_at, id) < ($3::timestamptz, $4::uuid))
         ORDER BY started_at DESC, id DESC
         LIMIT $5`,
        [accountId, options.sceneId ?? null, cursor?.t ?? null, cursor?.i ?? null, options.limit + 1],
    );
    const page = result.rows.slice(0, options.limit);
    const views = await loadRunViews(app.pg, page.map(row => row.id));
    const last = page.at(-1);
    return {
        runs: page.map(row => views.get(row.id)!).filter(Boolean),
        next_cursor: result.rows.length > options.limit && last ? encodeCursor(last.cursor_time, last.id) : null,
    };
}

export async function getRun(app: FastifyInstance, accountId: string, runId: string): Promise<SceneRunView> {
    const owner = await app.pg.query(
        'SELECT 1 FROM scene_runs WHERE id = $1 AND account_id = $2',
        [runId, accountId],
    );
    const run = owner.rows[0] ? (await loadRunViews(app.pg, [runId])).get(runId) : undefined;
    if (!run) throw httpError(404, 'SCENE_RUN_NOT_FOUND', 'Scene run not found');
    return run;
}
