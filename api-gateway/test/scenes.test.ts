import './setup-env';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { REDIS_CHANNELS } from '../../shared/constants';
import sceneRoutes from '../src/modules/scenes/routes';
import { purgeOldRuns, reconcileRuns, runDueSteps } from '../src/modules/scenes/runs';
import { createTestDatabase, skipWithoutDatabase, TestDatabase } from './helpers/testDatabase';
import { buildTestApp, recordPublishes, signUp, SignedInUser } from './helpers/testApp';
import { addMember, createOwnedDevice } from './helpers/fixtures';

let db: TestDatabase;
let app: FastifyInstance;
let published: Array<{ channel: string; payload: any }>;

const call = (user: SignedInUser, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string,
    payload?: object, headers: Record<string, string> = {}) =>
    app.inject({ method, url, headers: { ...user.headers, ...headers }, ...(payload ? { payload } : {}) });

// Published catalog revisions of the products used here.
const entrance = (db: TestDatabase, owner: string) =>
    createOwnedDevice(db.pool, owner, { name: 'Cửa chính', productId: 'prod_entrance_controller', catalogRevision: 6 });
const roof = (db: TestDatabase, owner: string) =>
    createOwnedDevice(db.pool, owner, { name: 'Mái sân thượng', productId: 'prod_roof_controller', catalogRevision: 2 });
const garden = (db: TestDatabase, owner: string) =>
    createOwnedDevice(db.pool, owner, { name: 'Tưới vườn', productId: 'prod_irrigation_manager', catalogRevision: 2 });

async function operationsOfRun(runId: string) {
    const result = await db.pool.query(
        `SELECT step.step_index, operation.id, operation.idempotency_key, operation.operation_name
         FROM scene_run_steps AS step JOIN device_operations AS operation ON operation.id = step.operation_id
         WHERE step.run_id = $1 ORDER BY step.step_index`,
        [runId],
    );
    return result.rows;
}

/** What the device worker does when the device answers. */
async function finishOperation(operationId: string, status: string, reason: string | null = null) {
    await db.pool.query(
        `UPDATE device_operations SET status = $2, reason_code = $3, completed_at = NOW() WHERE id = $1`,
        [operationId, status, reason],
    );
}

test.describe('scenes', { skip: skipWithoutDatabase }, () => {
    test.before(async () => {
        db = await createTestDatabase();
        app = await buildTestApp(db.pool, [sceneRoutes]);
        published = recordPublishes(app);
    });
    test.after(async () => {
        await app?.close();
        await db?.drop();
    });

    test('steps may only use operations that can be fixed in advance and that the account may run', async () => {
        const owner = await signUp(app);
        const member = await signUp(app);
        const door = await entrance(db, owner.id);
        await createOwnedDevice(db.pool, owner.id, { name: 'Camera cổng', productId: 'prod_security_camera' });
        await createOwnedDevice(db.pool, owner.id, {
            name: 'Báo cháy bếp', productId: 'prod_hazard_mitigation', catalogRevision: 6,
        });
        await addMember(db.pool, door, owner.id, member.id, 'viewer', ['device.view']);

        const devices = (await call(owner, 'GET', '/scenes/actions')).json().devices;
        const actions = Object.fromEntries(devices.map((device: any) => [
            device.name,
            device.actions.map((action: any) => `${action.operation}${action.protected ? '*' : ''}`).sort(),
        ]));
        assert.deepEqual(actions['Cửa chính'], ['clear_custom_message', 'lock', 'set_custom_message', 'unlock*']);
        // Incidents need a runtime id: acknowledge/reset are not scene actions.
        assert.deepEqual(actions['Báo cháy bếp'], ['mute_siren*', 'resume_siren', 'test_siren*']);
        // Live view, playback, listing and deleting recordings all need a person or a time range.
        assert.equal(actions['Camera cổng'], undefined);

        // A viewer cannot control the door, so it offers nothing.
        assert.deepEqual((await call(member, 'GET', '/scenes/actions')).json().devices, []);
        const forbidden = await call(member, 'POST', '/scenes', {
            name: 'Mở cửa', steps: [{ mac: door.mac, instance_id: 'main_lock', operation: 'unlock' }],
        });
        assert.equal(forbidden.statusCode, 403);
        assert.equal(forbidden.json().error.code, 'OPERATION_FORBIDDEN');
    });

    test('creates, edits and validates scenes', async () => {
        const owner = await signUp(app);
        const stranger = await signUp(app);
        const door = await entrance(db, owner.id);
        const cover = await roof(db, owner.id);
        const pump = await garden(db, owner.id);
        const notMine = await entrance(db, stranger.id);

        const created = await call(owner, 'POST', '/scenes', {
            name: '  Ra   khỏi nhà ', icon: 'leave_home',
            steps: [
                { mac: door.mac, instance_id: 'main_lock', operation: 'lock', delay_seconds: 30 },
                { mac: cover.mac.toLowerCase(), instance_id: 'roof_motor', operation: 'close', delay_seconds: 5 },
                { mac: pump.mac, instance_id: 'irrigation_pump', operation: 'water_for_duration', input: { duration_seconds: 300 } },
            ],
        });
        assert.equal(created.statusCode, 200, created.body);
        const scene = created.json().scene;
        assert.equal(scene.name, 'Ra khỏi nhà');
        assert.equal(scene.protected, false);
        assert.deepEqual(scene.steps.map((step: any) => [step.device.name, step.label, step.delay_seconds, step.available]), [
            ['Cửa chính', 'Khóa cửa', 0, true], // the first step starts right away
            ['Mái sân thượng', 'Đóng mái', 5, true],
            ['Tưới vườn', 'Bắt đầu tưới', 0, true],
        ]);

        const reject = async (steps: object[], code: string) => {
            const response = await call(owner, 'POST', '/scenes', { name: `Thử ${code}`, steps });
            assert.equal(response.json().error?.code, code, response.body);
        };
        await reject([{ mac: pump.mac, instance_id: 'irrigation_pump', operation: 'water_for_duration', input: { duration_seconds: 5 } }], 'OPERATION_INPUT_INVALID');
        await reject([{ mac: door.mac, instance_id: 'main_lock', operation: 'fly' }], 'OPERATION_NOT_SUPPORTED');
        await reject([{ mac: notMine.mac, instance_id: 'main_lock', operation: 'lock' }], 'DEVICE_NOT_FOUND');
        await reject(Array.from({ length: 11 }, () => ({ mac: door.mac, instance_id: 'main_lock', operation: 'lock' })), 'SCENE_TOO_MANY_STEPS');
        await reject([{ mac: door.mac, instance_id: 'main_lock', operation: 'lock', input: { pin: '1234' } }], 'OPERATION_INPUT_INVALID');
        const duplicate = await call(owner, 'POST', '/scenes', {
            name: 'ra KHỎI nhà', steps: [{ mac: door.mac, instance_id: 'main_lock', operation: 'lock' }],
        });
        assert.equal(duplicate.json().error.code, 'SCENE_NAME_TAKEN');

        const edited = await call(owner, 'PATCH', `/scenes/${scene.id}`, {
            name: 'Đi làm', steps: [{ mac: door.mac, instance_id: 'main_lock', operation: 'unlock' }],
        });
        assert.equal(edited.statusCode, 200, edited.body);
        assert.equal(edited.json().scene.protected, true);
        assert.equal((await call(stranger, 'PATCH', `/scenes/${scene.id}`, { name: 'X' })).statusCode, 404);

        const other = (await call(owner, 'POST', '/scenes', {
            name: 'Tưới sáng', steps: [{ mac: pump.mac, instance_id: 'irrigation_pump', operation: 'stop' }],
        })).json().scene;
        assert.equal((await call(owner, 'PUT', '/scenes/order', { scene_ids: [other.id, scene.id] })).statusCode, 200);
        const listed = (await call(owner, 'GET', '/scenes')).json();
        assert.deepEqual(listed.scenes.map((item: any) => item.name), ['Tưới sáng', 'Đi làm']);
        assert.deepEqual(listed.limits, { max_scenes: 50, max_steps: 10, max_schedules: 5 });
        assert.deepEqual((await call(stranger, 'GET', '/scenes')).json().scenes, []);
    });

    test('a run sends due steps, waits for delays, records results and reports progress', async () => {
        const owner = await signUp(app);
        const door = await entrance(db, owner.id);
        const cover = await roof(db, owner.id);
        const pump = await garden(db, owner.id);
        const scene = (await call(owner, 'POST', '/scenes', {
            name: 'Ra khỏi nhà',
            steps: [
                { mac: door.mac, instance_id: 'main_lock', operation: 'lock' },
                { mac: cover.mac, instance_id: 'roof_motor', operation: 'close', delay_seconds: 5 },
                { mac: pump.mac, instance_id: 'irrigation_pump', operation: 'water_for_duration', input: { duration_seconds: 300 } },
            ],
        })).json().scene;

        published.length = 0;
        const started = await call(owner, 'POST', `/scenes/${scene.id}/run`);
        assert.equal(started.statusCode, 200, started.body);
        const run = started.json().run;
        assert.equal(run.status, 'running');
        assert.deepEqual(run.steps.map((step: any) => step.status), ['dispatched', 'pending', 'pending']);
        assert.equal((await call(owner, 'POST', `/scenes/${scene.id}/run`)).json().error.code, 'SCENE_ALREADY_RUNNING');

        // Not due yet: nothing moves.
        assert.equal(await runDueSteps(app), 0);
        await db.pool.query(`UPDATE scene_runs SET next_step_at = NOW() - interval '1 second' WHERE id = $1`, [run.id]);
        assert.equal(await runDueSteps(app), 1);
        const operations = await operationsOfRun(run.id);
        assert.deepEqual(operations.map(row => [row.operation_name, row.idempotency_key]), [
            ['lock', `scene-run:${run.id}:0`],
            ['close', `scene-run:${run.id}:1`],
            ['water_for_duration', `scene-run:${run.id}:2`],
        ]);

        await finishOperation(operations[0].id, 'succeeded');
        await finishOperation(operations[1].id, 'timed_out', 'OPERATION_TIMEOUT');
        assert.deepEqual(await reconcileRuns(app), [run.id]);
        let view = (await call(owner, 'GET', `/scene-runs/${run.id}`)).json().run;
        assert.equal(view.status, 'running');
        assert.deepEqual(view.steps.map((step: any) => [step.status, step.reason_code]), [
            ['succeeded', null], ['failed', 'OPERATION_TIMEOUT'], ['dispatched', null],
        ]);

        await finishOperation(operations[2].id, 'succeeded');
        await reconcileRuns(app);
        view = (await call(owner, 'GET', `/scene-runs/${run.id}`)).json().run;
        assert.equal(view.status, 'partial');
        assert.ok(view.finished_at);

        const updates = published.filter(item => item.channel === REDIS_CHANNELS.ACCOUNT_EVENT
            && item.payload.event === 'scene_run_updated' && item.payload.account_id === owner.id);
        assert.ok(updates.length >= 3);
        assert.equal(updates.at(-1)!.payload.data.run.status, 'partial');

        // Moving a finished run again sends nothing new.
        await db.pool.query(`UPDATE scene_runs SET next_step_at = NULL WHERE id = $1`, [run.id]);
        assert.equal(await runDueSteps(app), 0);
        assert.equal((await operationsOfRun(run.id)).length, 3);

        const listed = (await call(owner, 'GET', '/scenes')).json().scenes[0];
        assert.equal(listed.last_run.status, 'partial');
        // Now it can run again.
        assert.equal((await call(owner, 'POST', `/scenes/${scene.id}/run`)).statusCode, 200);
    });

    test('protected steps need the account password for every run', async () => {
        const owner = await signUp(app);
        const door = await entrance(db, owner.id);
        const scene = (await call(owner, 'POST', '/scenes', {
            name: 'Về nhà', steps: [{ mac: door.mac, instance_id: 'main_lock', operation: 'unlock' }],
        })).json().scene;

        const refused = await call(owner, 'POST', `/scenes/${scene.id}/run`);
        assert.equal(refused.statusCode, 403);
        assert.equal(refused.json().error.code, 'REAUTHENTICATION_REQUIRED');

        const reauth = await call(owner, 'POST', '/auth/reauthenticate', { password: owner.password });
        assert.equal(reauth.statusCode, 200, reauth.body);
        const token = reauth.json().reauth_token;
        const other = await signUp(app);
        // Somebody else's confirmation does not count.
        const otherToken = (await call(other, 'POST', '/auth/reauthenticate', { password: other.password })).json().reauth_token;
        assert.equal((await call(owner, 'POST', `/scenes/${scene.id}/run`, undefined, { 'x-reauth-token': otherToken })).statusCode, 403);

        const ran = await call(owner, 'POST', `/scenes/${scene.id}/run`, undefined, { 'x-reauth-token': token });
        assert.equal(ran.statusCode, 200, ran.body);
        assert.equal(ran.json().run.steps[0].status, 'dispatched');
    });

    test('a step that cannot be sent fails with its reason and the run still finishes', async () => {
        const owner = await signUp(app);
        const member = await signUp(app);
        const cover = await roof(db, owner.id);
        const pump = await garden(db, member.id);
        await addMember(db.pool, cover, owner.id, member.id, 'controller', ['device.view', 'cover.control']);
        const scene = (await call(member, 'POST', '/scenes', {
            name: 'Đóng mái',
            steps: [
                { mac: cover.mac, instance_id: 'roof_motor', operation: 'close' },
                { mac: pump.mac, instance_id: 'irrigation_pump', operation: 'stop' },
            ],
        })).json().scene;

        // The owner takes the roof back: the member's step is now unavailable.
        await db.pool.query('DELETE FROM device_memberships WHERE device_id = $1 AND account_id = $2', [cover.id, member.id]);
        const steps = (await call(member, 'GET', '/scenes')).json().scenes[0].steps;
        assert.deepEqual(steps.map((step: any) => step.available), [false, true]);

        const run = (await call(member, 'POST', `/scenes/${scene.id}/run`)).json().run;
        assert.deepEqual(run.steps.map((step: any) => [step.status, step.reason_code]), [
            ['failed', 'DEVICE_NOT_FOUND'], ['dispatched', null],
        ]);
        // The failed step never became a device operation; only the pump's did.
        const [stop] = await operationsOfRun(run.id);
        await finishOperation(stop.id, 'succeeded');
        await reconcileRuns(app);
        assert.equal((await call(member, 'GET', `/scene-runs/${run.id}`)).json().run.status, 'partial');

        // Unpairing a device while its step waits fails that step instead of leaving the run open.
        const second = (await call(member, 'POST', `/scenes/${scene.id}/run`)).json().run;
        await db.pool.query('DELETE FROM device_metadata WHERE id = $1', [pump.id]);
        await reconcileRuns(app);
        const closed = (await call(member, 'GET', `/scene-runs/${second.id}`)).json().run;
        assert.equal(closed.status, 'failed');
        assert.deepEqual(closed.steps.map((step: any) => step.reason_code), ['DEVICE_NOT_FOUND', 'DEVICE_REMOVED']);
        // The scene lost the removed device's step but keeps the rest.
        assert.equal((await call(member, 'GET', '/scenes')).json().scenes[0].steps.length, 1);
    });

    test('history is paged, private, survives deleting the scene and is trimmed after the retention period', async () => {
        const owner = await signUp(app);
        const stranger = await signUp(app);
        const cover = await roof(db, owner.id);
        const scene = (await call(owner, 'POST', '/scenes', {
            name: 'Đóng mái', steps: [{ mac: cover.mac, instance_id: 'roof_motor', operation: 'close' }],
        })).json().scene;
        const runIds: string[] = [];
        for (let index = 0; index < 3; index += 1) {
            const run = (await call(owner, 'POST', `/scenes/${scene.id}/run`)).json().run;
            const [operation] = await operationsOfRun(run.id);
            await finishOperation(operation.id, 'succeeded');
            await reconcileRuns(app);
            runIds.push(run.id);
        }

        const first = (await call(owner, 'GET', '/scene-runs?limit=2')).json();
        assert.deepEqual(first.runs.map((run: any) => run.id), [runIds[2], runIds[1]]);
        assert.ok(first.next_cursor);
        const second = (await call(owner, 'GET', `/scene-runs?limit=2&before=${first.next_cursor}`)).json();
        assert.deepEqual(second.runs.map((run: any) => run.id), [runIds[0]]);
        assert.equal(second.next_cursor, null);
        assert.equal((await call(owner, 'GET', `/scene-runs?scene_id=${scene.id}`)).json().runs.length, 3);
        assert.equal((await call(owner, 'GET', '/scene-runs?before=bad')).json().error.code, 'INVALID_CURSOR');
        assert.equal((await call(stranger, 'GET', `/scene-runs/${runIds[0]}`)).statusCode, 404);
        assert.deepEqual((await call(stranger, 'GET', '/scene-runs')).json().runs, []);

        assert.equal((await call(owner, 'DELETE', `/scenes/${scene.id}`)).statusCode, 200);
        const kept = (await call(owner, 'GET', `/scene-runs/${runIds[0]}`)).json().run;
        assert.deepEqual([kept.scene_id, kept.scene_name, kept.status], [null, 'Đóng mái', 'succeeded']);

        await db.pool.query(
            `UPDATE scene_runs SET started_at = NOW() - interval '40 days', finished_at = NOW() - interval '40 days'
             WHERE id = $1`,
            [runIds[0]],
        );
        assert.equal(await purgeOldRuns(app), 1);
        assert.equal((await call(owner, 'GET', `/scene-runs/${runIds[0]}`)).statusCode, 404);
        assert.equal((await call(owner, 'GET', `/scene-runs/${runIds[1]}`)).statusCode, 200);
    });
});
