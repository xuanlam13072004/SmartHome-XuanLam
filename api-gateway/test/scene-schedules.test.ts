import './setup-env';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import sceneRoutes from '../src/modules/scenes/routes';
import { reconcileRuns } from '../src/modules/scenes/runs';
import { runDueSchedules } from '../src/modules/scenes/schedules';
import { createTestDatabase, skipWithoutDatabase, TestDatabase } from './helpers/testDatabase';
import { buildTestApp, signUp, SignedInUser } from './helpers/testApp';
import { createOwnedDevice } from './helpers/fixtures';

let db: TestDatabase;
let app: FastifyInstance;

const ZONE = 'Asia/Ho_Chi_Minh';

const call = (user: SignedInUser, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, headers: user.headers, ...(payload ? { payload } : {}) });

async function sceneWithRoof(owner: SignedInUser, name = 'Đóng mái') {
    const roof = await createOwnedDevice(db.pool, owner.id, {
        name: 'Mái sân thượng', productId: 'prod_roof_controller', catalogRevision: 2,
    });
    const scene = (await call(owner, 'POST', '/scenes', {
        name, steps: [{ mac: roof.mac, instance_id: 'roof_motor', operation: 'close' }],
    })).json().scene;
    return { roof, scene };
}

async function expectedNext(time: string, days: number[]) {
    const result = await db.pool.query(
        `SELECT scene_schedule_next_run($1::time, $2::smallint[], $3, NOW()) AS next`,
        [time, days, ZONE],
    );
    return (result.rows[0].next as Date).toISOString();
}

async function scheduleRow(id: string) {
    return (await db.pool.query('SELECT * FROM scene_schedules WHERE id = $1', [id])).rows[0];
}

async function makeDue(id: string, ago = '1 minute') {
    await db.pool.query(`UPDATE scene_schedules SET next_run_at = NOW() - $2::interval WHERE id = $1`, [id, ago]);
}

async function runsOf(sceneId: string) {
    return (await db.pool.query(
        'SELECT id, trigger, status FROM scene_runs WHERE scene_id = $1 ORDER BY started_at',
        [sceneId],
    )).rows;
}

test.describe('scene schedules', { skip: skipWithoutDatabase }, () => {
    test.before(async () => {
        db = await createTestDatabase();
        app = await buildTestApp(db.pool, [sceneRoutes]);
    });
    test.after(async () => {
        await app?.close();
        await db?.drop();
    });

    test('a schedule runs at a local time on chosen weekdays and can be changed or turned off', async () => {
        const owner = await signUp(app);
        const stranger = await signUp(app);
        const { scene } = await sceneWithRoof(owner);

        const created = await call(owner, 'POST', `/scenes/${scene.id}/schedules`, {
            time: '06:30', days: [5, 1, 1, 2, 3, 4], timezone: ZONE,
        });
        assert.equal(created.statusCode, 200, created.body);
        const schedule = created.json().schedule;
        assert.deepEqual([schedule.time, schedule.days, schedule.enabled], ['06:30', [1, 2, 3, 4, 5], true]);
        assert.equal(schedule.next_run_at, await expectedNext('06:30', [1, 2, 3, 4, 5]));
        assert.deepEqual((await call(owner, 'GET', '/scenes')).json().scenes[0].schedules.map((item: any) => item.id), [schedule.id]);

        const reject = async (body: object, code: string) => {
            const response = await call(owner, 'POST', `/scenes/${scene.id}/schedules`, body);
            assert.equal(response.json().error?.code, code, response.body);
        };
        await reject({ time: '06:30', days: [1, 2, 3, 4, 5], timezone: ZONE }, 'SCENE_SCHEDULE_DUPLICATE');
        await reject({ time: '07:00', days: [1], timezone: 'Mars/Olympus' }, 'INVALID_TIMEZONE');
        await reject({ time: '24:00', days: [1], timezone: ZONE }, 'VALIDATION_ERROR');
        await reject({ time: '07:00', days: [], timezone: ZONE }, 'VALIDATION_ERROR');
        for (const time of ['07:00', '08:00', '09:00', '10:00']) {
            assert.equal((await call(owner, 'POST', `/scenes/${scene.id}/schedules`, { time, days: [6], timezone: ZONE })).statusCode, 200);
        }
        await reject({ time: '11:00', days: [6], timezone: ZONE }, 'SCENE_SCHEDULE_LIMIT');

        const off = (await call(owner, 'PATCH', `/scene-schedules/${schedule.id}`, { enabled: false })).json().schedule;
        assert.deepEqual([off.enabled, off.next_run_at], [false, null]);
        const moved = (await call(owner, 'PATCH', `/scene-schedules/${schedule.id}`, { enabled: true, time: '05:45', days: [7] })).json().schedule;
        assert.equal(moved.next_run_at, await expectedNext('05:45', [7]));

        assert.equal((await call(stranger, 'PATCH', `/scene-schedules/${schedule.id}`, { enabled: false })).statusCode, 404);
        assert.equal((await call(stranger, 'POST', `/scenes/${scene.id}/schedules`, { time: '12:00', days: [1], timezone: ZONE })).statusCode, 404);
        assert.equal((await call(stranger, 'DELETE', `/scene-schedules/${schedule.id}`)).statusCode, 404);
        assert.equal((await call(owner, 'DELETE', `/scene-schedules/${schedule.id}`)).statusCode, 200);
        assert.equal((await call(owner, 'GET', '/scenes')).json().scenes[0].schedules.length, 4);
    });

    test('scenes whose steps need the password cannot run unattended', async () => {
        const owner = await signUp(app);
        const door = await createOwnedDevice(db.pool, owner.id, {
            name: 'Cửa chính', productId: 'prod_entrance_controller', catalogRevision: 6,
        });
        const unlock = { mac: door.mac, instance_id: 'main_lock', operation: 'unlock' };
        const lock = { mac: door.mac, instance_id: 'main_lock', operation: 'lock' };
        const welcome = (await call(owner, 'POST', '/scenes', { name: 'Về nhà', steps: [unlock] })).json().scene;
        const refused = await call(owner, 'POST', `/scenes/${welcome.id}/schedules`, { time: '17:00', days: [1], timezone: ZONE });
        assert.equal(refused.json().error.code, 'SCENE_PROTECTED_STEPS');

        const night = (await call(owner, 'POST', '/scenes', { name: 'Đi ngủ', steps: [lock] })).json().scene;
        const schedule = (await call(owner, 'POST', `/scenes/${night.id}/schedules`, { time: '22:30', days: [1, 2, 3], timezone: ZONE })).json().schedule;
        const blocked = await call(owner, 'PATCH', `/scenes/${night.id}`, { steps: [lock, unlock] });
        assert.equal(blocked.json().error.code, 'SCENE_HAS_SCHEDULES');

        await call(owner, 'PATCH', `/scene-schedules/${schedule.id}`, { enabled: false });
        assert.equal((await call(owner, 'PATCH', `/scenes/${night.id}`, { steps: [lock, unlock] })).statusCode, 200);
        const reEnable = await call(owner, 'PATCH', `/scene-schedules/${schedule.id}`, { enabled: true });
        assert.equal(reEnable.json().error.code, 'SCENE_PROTECTED_STEPS');
    });

    test('a due schedule fires exactly once, skips while the scene runs and records missed occurrences', async () => {
        const owner = await signUp(app);
        const { scene } = await sceneWithRoof(owner, 'Đóng mái tối');
        const schedule = (await call(owner, 'POST', `/scenes/${scene.id}/schedules`, {
            time: '19:00', days: [1, 2, 3, 4, 5, 6, 7], timezone: ZONE,
        })).json().schedule;

        assert.equal(await runDueSchedules(app), 0, 'not due yet');
        await makeDue(schedule.id);
        // Two runner instances at once: the row lock lets only one fire it.
        const handled = await Promise.all([runDueSchedules(app), runDueSchedules(app)]);
        assert.equal(handled[0] + handled[1], 1);
        let runs = await runsOf(scene.id);
        assert.deepEqual(runs.map(run => [run.trigger, run.status]), [['schedule', 'running']]);
        let row = await scheduleRow(schedule.id);
        assert.deepEqual([row.last_result, row.last_run_id], ['started', runs[0].id]);
        assert.ok(row.next_run_at > new Date());
        const sent = (await db.pool.query(
            `SELECT status FROM scene_run_steps WHERE run_id = $1`, [runs[0].id],
        )).rows;
        assert.deepEqual(sent.map(step => step.status), ['dispatched'], 'the first step is sent right away');

        // Still running when the next occurrence comes: skipped, not queued.
        await makeDue(schedule.id);
        assert.equal(await runDueSchedules(app), 1);
        assert.equal((await scheduleRow(schedule.id)).last_result, 'skipped_running');
        assert.equal((await runsOf(scene.id)).length, 1);

        await db.pool.query(
            `UPDATE device_operations SET status = 'succeeded', completed_at = NOW()
             WHERE id = (SELECT operation_id FROM scene_run_steps WHERE run_id = $1)`,
            [runs[0].id],
        );
        await reconcileRuns(app);

        // The Gateway was down for an hour: the occurrence is missed, not run late.
        await makeDue(schedule.id, '1 hour');
        assert.equal(await runDueSchedules(app), 1);
        row = await scheduleRow(schedule.id);
        assert.equal(row.last_result, 'missed');
        runs = await runsOf(scene.id);
        assert.deepEqual(runs.map(run => run.status), ['succeeded']);
        assert.ok(row.next_run_at > new Date());
    });

    test('an occurrence that cannot run records why', async () => {
        const owner = await signUp(app);
        const { roof, scene } = await sceneWithRoof(owner, 'Kiểm tra');
        const schedule = (await call(owner, 'POST', `/scenes/${scene.id}/schedules`, {
            time: '03:00', days: [1], timezone: ZONE,
        })).json().schedule;

        // Steps changed behind the API's back (e.g. a catalog update made one protected).
        const door = await createOwnedDevice(db.pool, owner.id, { productId: 'prod_entrance_controller', catalogRevision: 6 });
        await db.pool.query(
            `INSERT INTO scene_steps (scene_id, step_index, device_id, instance_id, operation_name)
             VALUES ($1, 1, $2, 'main_lock', 'unlock')`,
            [scene.id, door.id],
        );
        await makeDue(schedule.id);
        await runDueSchedules(app);
        assert.equal((await scheduleRow(schedule.id)).last_result, 'skipped_protected');

        await db.pool.query('DELETE FROM scene_steps WHERE scene_id = $1', [scene.id]);
        await makeDue(schedule.id);
        await runDueSchedules(app);
        assert.equal((await scheduleRow(schedule.id)).last_result, 'skipped_empty');
        assert.equal((await runsOf(scene.id)).length, 0);
        assert.ok(roof.id);
    });
});
