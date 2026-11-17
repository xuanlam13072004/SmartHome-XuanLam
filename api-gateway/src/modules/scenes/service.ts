import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { env } from '../../config/env';
import { httpError } from '../../utils/httpError';
import { validateObjectAgainstSchema } from '../../../../shared/validation';
import { loadAccessibleDevices } from '../device/service';
import {
    instanceLabel,
    isProtectedOperation,
    mayRun,
    operationLabel,
    sceneActionProblem,
} from './actions';
import { loadSchedules, type SceneScheduleView } from './schedules';
import type { SceneStepInput } from './schemas';

export interface SceneStepView {
    index: number;
    device: { mac: string; name: string; product_id: string };
    instance_id: string;
    instance_label: string;
    operation: string;
    label: string;
    input: Record<string, unknown>;
    delay_seconds: number;
    protected: boolean;
    /** False when the device is gone from this account or the action is no longer allowed. */
    available: boolean;
}

export interface SceneView {
    id: string;
    name: string;
    icon: string;
    position: number;
    steps: SceneStepView[];
    protected: boolean;
    last_run: { id: string; status: string; started_at: string; finished_at: string | null } | null;
    schedules: SceneScheduleView[];
}

async function inTransaction<T>(app: FastifyInstance, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await app.pg.connect();
    try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
    } catch (error: any) {
        await client.query('ROLLBACK');
        if (error?.code === '23505') throw httpError(409, 'SCENE_NAME_TAKEN', 'A scene with this name already exists');
        throw error;
    } finally {
        client.release();
    }
}

/** Serialises scene (and automation) changes of one account so limits and positions stay exact. */
export async function lockAccount(client: PoolClient, accountId: string) {
    const result = await client.query(`SELECT 1 FROM accounts WHERE id = $1 AND status = 'active' FOR UPDATE`, [accountId]);
    if (!result.rows[0]) throw httpError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
}

// ── Actions a step may use ─────────────────────────────────────────────────

/** Every device the caller can see, with the operations a scene step may use on it. */
export async function listSceneActions(app: FastifyInstance, accountId: string) {
    const result = await app.pg.query(
        `SELECT device.mac, device.name, device.product_id, device.catalog_revision,
                membership.role, membership.room_id,
                COALESCE(ARRAY_AGG(permission.permission_scope)
                    FILTER (WHERE permission.permission_scope IS NOT NULL),
                    ARRAY[]::text[]) AS granted_permissions
         FROM device_memberships AS membership
         JOIN device_metadata AS device ON device.id = membership.device_id AND device.is_active = true
         LEFT JOIN device_membership_permissions AS permission
           ON permission.device_id = membership.device_id
          AND permission.account_id = membership.account_id
         WHERE membership.account_id = $1 AND membership.status = 'active'
           AND (membership.expires_at IS NULL OR membership.expires_at > NOW())
         GROUP BY device.id, membership.role, membership.room_id
         ORDER BY device.name, device.mac`,
        [accountId],
    );
    return result.rows.map(device => {
        const product = app.catalog.getProduct(device.product_id) as any;
        const actions = product && product.catalog_revision === device.catalog_revision
            ? Object.values(product.operations as Record<string, any>)
                .filter(operation => !sceneActionProblem(operation) && mayRun(device, operation))
                .map(operation => ({
                    instance_id: operation.instance_id as string,
                    instance_label: instanceLabel(product, operation.instance_id),
                    operation: operation.id as string,
                    label: operationLabel(operation, operation.id),
                    protected: isProtectedOperation(operation),
                    input: operation.input || {},
                }))
            : [];
        return {
            mac: device.mac,
            name: device.name,
            product_id: device.product_id,
            room_id: device.room_id,
            actions,
        };
    }).filter(device => device.actions.length > 0);
}

/** Checks every step against the caller's devices, permissions and the catalog. */
export async function resolveSteps(app: FastifyInstance, accountId: string, steps: SceneStepInput[]) {
    if (steps.length > env.MAX_SCENE_STEPS) {
        throw httpError(400, 'SCENE_TOO_MANY_STEPS', `A scene can have at most ${env.MAX_SCENE_STEPS} steps`);
    }
    const devices = await loadAccessibleDevices(app, [...new Set(steps.map(step => step.mac))], accountId);
    return steps.map((step, index) => {
        const device = devices.get(step.mac);
        if (!device) throw httpError(404, 'DEVICE_NOT_FOUND', `Step ${index + 1}: device not found`);
        const product = app.catalog.getProduct(device.product_id) as any;
        const operation = product && product.catalog_revision === device.catalog_revision
            ? app.catalog.getOperation(device.product_id, step.instance_id, step.operation) as any
            : null;
        if (!operation) throw httpError(400, 'OPERATION_NOT_SUPPORTED', `Step ${index + 1}: operation not supported`);
        if (sceneActionProblem(operation)) {
            throw httpError(400, 'SCENE_ACTION_NOT_ALLOWED', `Step ${index + 1}: this operation cannot be used in a scene`);
        }
        if (!mayRun(device, operation)) {
            throw httpError(403, 'OPERATION_FORBIDDEN', `Step ${index + 1}: permission denied`);
        }
        const validation = validateObjectAgainstSchema(step.input, operation.input || {});
        if (!validation.valid) {
            throw httpError(400, 'OPERATION_INPUT_INVALID', `Step ${index + 1}: ${validation.error || 'invalid input'}`);
        }
        return {
            step_index: index,
            device_id: device.id as string,
            instance_id: step.instance_id,
            operation_name: step.operation,
            input: step.input,
            // The first step starts when the scene starts.
            delay_seconds: index === 0 ? 0 : step.delay_seconds,
            protected: isProtectedOperation(operation),
        };
    });
}

export type ResolvedSteps = Awaited<ReturnType<typeof resolveSteps>>;

async function writeSteps(client: PoolClient, sceneId: string, steps: ResolvedSteps) {
    await client.query('DELETE FROM scene_steps WHERE scene_id = $1', [sceneId]);
    await client.query(
        `INSERT INTO scene_steps (scene_id, step_index, device_id, instance_id, operation_name, input, delay_seconds)
         SELECT $1, step.step_index, step.device_id, step.instance_id, step.operation_name, step.input, step.delay_seconds
         FROM jsonb_to_recordset($2::jsonb)
              AS step(step_index smallint, device_id uuid, instance_id text, operation_name text,
                      input jsonb, delay_seconds integer)`,
        [sceneId, JSON.stringify(steps)],
    );
}

// ── Scenes ─────────────────────────────────────────────────────────────────

/** The account's scenes in display order with their steps and last run. */
export async function listScenes(app: FastifyInstance, accountId: string, sceneId?: string): Promise<SceneView[]> {
    const scenes = await app.pg.query(
        `SELECT scene.id, scene.name, scene.icon, scene.position,
                last.id AS last_run_id, last.status AS last_run_status,
                last.started_at AS last_run_started_at, last.finished_at AS last_run_finished_at
         FROM scenes AS scene
         LEFT JOIN LATERAL (
             SELECT run.id, run.status, run.started_at, run.finished_at FROM scene_runs AS run
             WHERE run.scene_id = scene.id ORDER BY run.started_at DESC LIMIT 1
         ) AS last ON true
         WHERE scene.account_id = $1 AND ($2::uuid IS NULL OR scene.id = $2)
         ORDER BY scene.position, scene.created_at`,
        [accountId, sceneId ?? null],
    );
    if (scenes.rows.length === 0) return [];
    const steps = await app.pg.query(
        `SELECT step.scene_id, step.step_index, step.instance_id, step.operation_name, step.input,
                step.delay_seconds, device.mac, device.name AS device_name, device.product_id,
                device.catalog_revision, device.is_active, membership.role,
                COALESCE(ARRAY_AGG(permission.permission_scope)
                    FILTER (WHERE permission.permission_scope IS NOT NULL),
                    ARRAY[]::text[]) AS granted_permissions
         FROM scene_steps AS step
         JOIN scenes AS scene ON scene.id = step.scene_id
         JOIN device_metadata AS device ON device.id = step.device_id
         LEFT JOIN device_memberships AS membership
           ON membership.device_id = device.id AND membership.account_id = scene.account_id
          AND membership.status = 'active'
          AND (membership.expires_at IS NULL OR membership.expires_at > NOW())
         LEFT JOIN device_membership_permissions AS permission
           ON permission.device_id = membership.device_id
          AND permission.account_id = membership.account_id
         WHERE scene.id = ANY($1::uuid[])
         GROUP BY step.scene_id, step.step_index, device.id, membership.role
         ORDER BY step.scene_id, step.step_index`,
        [scenes.rows.map(row => row.id)],
    );
    const stepsByScene = new Map<string, SceneStepView[]>();
    for (const row of steps.rows) {
        const product = app.catalog.getProduct(row.product_id) as any;
        const operation = product && product.catalog_revision === row.catalog_revision
            ? app.catalog.getOperation(row.product_id, row.instance_id, row.operation_name) as any
            : null;
        const available = Boolean(row.is_active && row.role && operation
            && !sceneActionProblem(operation) && mayRun(row, operation));
        const list = stepsByScene.get(row.scene_id) ?? [];
        list.push({
            index: list.length,
            device: { mac: row.mac, name: row.device_name, product_id: row.product_id },
            instance_id: row.instance_id,
            instance_label: instanceLabel(product, row.instance_id),
            operation: row.operation_name,
            label: operation ? operationLabel(operation, row.operation_name) : row.operation_name,
            input: row.input,
            delay_seconds: list.length === 0 ? 0 : row.delay_seconds,
            protected: operation ? isProtectedOperation(operation) : false,
            available,
        });
        stepsByScene.set(row.scene_id, list);
    }
    const schedulesByScene = await loadSchedules(app, scenes.rows.map(row => row.id));
    return scenes.rows.map(row => {
        const sceneSteps = stepsByScene.get(row.id) ?? [];
        return {
            id: row.id,
            name: row.name,
            icon: row.icon,
            position: row.position,
            steps: sceneSteps,
            protected: sceneSteps.some(step => step.protected),
            last_run: row.last_run_id
                ? {
                    id: row.last_run_id,
                    status: row.last_run_status,
                    started_at: row.last_run_started_at,
                    finished_at: row.last_run_finished_at,
                }
                : null,
            schedules: schedulesByScene.get(row.id) ?? [],
        };
    });
}

async function getScene(app: FastifyInstance, accountId: string, sceneId: string) {
    const [scene] = await listScenes(app, accountId, sceneId);
    if (!scene) throw httpError(404, 'SCENE_NOT_FOUND', 'Scene not found');
    return scene;
}

/** Adds a scene with already resolved steps inside the caller's transaction (also used by suggestions). */
export async function insertScene(
    client: PoolClient,
    accountId: string,
    input: { name: string; icon: string; steps: ResolvedSteps },
): Promise<string> {
    await lockAccount(client, accountId);
    const stats = await client.query(
        `SELECT count(*)::int AS count, COALESCE(max(position) + 1, 0) AS next
         FROM scenes WHERE account_id = $1`,
        [accountId],
    );
    if (stats.rows[0].count >= env.MAX_SCENES_PER_ACCOUNT) {
        throw httpError(409, 'SCENE_LIMIT_REACHED', `An account can have at most ${env.MAX_SCENES_PER_ACCOUNT} scenes`);
    }
    const inserted = await client.query(
        `INSERT INTO scenes (account_id, name, icon, position) VALUES ($1, $2, $3, $4) RETURNING id`,
        [accountId, input.name, input.icon, stats.rows[0].next],
    );
    await writeSteps(client, inserted.rows[0].id, input.steps);
    return inserted.rows[0].id as string;
}

export async function createScene(
    app: FastifyInstance,
    accountId: string,
    input: { name: string; icon: string; steps: SceneStepInput[] },
) {
    const steps = await resolveSteps(app, accountId, input.steps);
    const sceneId = await inTransaction(app, client => insertScene(client, accountId, { ...input, steps }));
    return getScene(app, accountId, sceneId);
}

/** Renames, changes the icon and/or replaces all steps. A run in progress keeps its own copy. */
export async function updateScene(
    app: FastifyInstance,
    accountId: string,
    sceneId: string,
    input: { name?: string; icon?: string; steps?: SceneStepInput[] },
) {
    const steps = input.steps ? await resolveSteps(app, accountId, input.steps) : null;
    await inTransaction(app, async (client) => {
        const updated = await client.query(
            `UPDATE scenes SET name = COALESCE($3, name), icon = COALESCE($4, icon), updated_at = NOW()
             WHERE id = $1 AND account_id = $2 RETURNING id`,
            [sceneId, accountId, input.name ?? null, input.icon ?? null],
        );
        if (!updated.rows[0]) throw httpError(404, 'SCENE_NOT_FOUND', 'Scene not found');
        if (steps?.some(step => step.protected)) {
            // Scheduled and automatic runs have nobody to type the password.
            const scheduled = await client.query(
                'SELECT 1 FROM scene_schedules WHERE scene_id = $1 AND enabled LIMIT 1',
                [sceneId],
            );
            if (scheduled.rows[0]) {
                throw httpError(409, 'SCENE_HAS_SCHEDULES',
                    'Turn off the schedules of this scene before adding steps that need the password');
            }
            const automated = await client.query('SELECT 1 FROM automations WHERE scene_id = $1 LIMIT 1', [sceneId]);
            if (automated.rows[0]) {
                throw httpError(409, 'SCENE_USED_BY_AUTOMATION',
                    'This scene is run by an automation, so it cannot have steps that need the password');
            }
        }
        if (steps) await writeSteps(client, sceneId, steps);
    });
    return getScene(app, accountId, sceneId);
}

/** History stays (scene_runs.scene_id becomes NULL); a run in progress finishes. */
export async function deleteScene(app: FastifyInstance, accountId: string, sceneId: string) {
    const result = await app.pg.query(
        'DELETE FROM scenes WHERE id = $1 AND account_id = $2 RETURNING id',
        [sceneId, accountId],
    );
    if (!result.rows[0]) throw httpError(404, 'SCENE_NOT_FOUND', 'Scene not found');
}

/** `sceneIds` must list every scene of the account exactly once, in the new order. */
export async function reorderScenes(app: FastifyInstance, accountId: string, sceneIds: string[]) {
    await inTransaction(app, async (client) => {
        await lockAccount(client, accountId);
        const existing = await client.query('SELECT id FROM scenes WHERE account_id = $1', [accountId]);
        const known = new Set(existing.rows.map(row => row.id as string));
        const requested = new Set(sceneIds);
        if (requested.size !== sceneIds.length || requested.size !== known.size
            || sceneIds.some(id => !known.has(id))) {
            throw httpError(400, 'SCENE_ORDER_MISMATCH', 'The order must list every scene exactly once');
        }
        await client.query(
            `UPDATE scenes AS scene SET position = ordered.position - 1
             FROM unnest($2::uuid[]) WITH ORDINALITY AS ordered(id, position)
             WHERE scene.id = ordered.id AND scene.account_id = $1`,
            [accountId, sceneIds],
        );
    });
}
