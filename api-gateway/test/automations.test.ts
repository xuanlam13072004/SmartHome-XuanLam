import './setup-env';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { MongoClient, ObjectId } from 'mongodb';
import automationRoutes from '../src/modules/automations/routes';
import { runDueAutomations } from '../src/modules/automations/firing';
import notificationRoutes from '../src/modules/notifications/routes';
import sceneRoutes from '../src/modules/scenes/routes';
import { AutomationEngine } from '../src/workers/automationEngine';
import { REDIS_CHANNELS } from '../../shared/constants';
import { createTestDatabase, skipWithoutMongo, TEST_MONGO_URL, TestDatabase } from './helpers/testDatabase';
import { buildTestApp, recordPublishes, signUp, SignedInUser } from './helpers/testApp';
import { addMember, createOwnedDevice } from './helpers/fixtures';

let db: TestDatabase;
let app: FastifyInstance;
let mongo: MongoClient;

const ZONE = 'Asia/Ho_Chi_Minh';
const DOOR_STATE = 'instances.door_position.reported.door_state';
const LOCK_STATE = 'instances.main_lock.reported.lock_state';

const call = (user: SignedInUser, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, headers: user.headers, ...(payload ? { payload } : {}) });

const entrance = (owner: SignedInUser, name = 'Cửa chính') =>
    createOwnedDevice(db.pool, owner.id, { name, productId: 'prod_entrance_controller', catalogRevision: 6 });

async function lockScene(owner: SignedInUser, mac: string, name = 'Khóa cửa', operation = 'lock') {
    const response = await call(owner, 'POST', '/scenes', {
        name, steps: [{ mac, instance_id: 'main_lock', operation }],
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().scene;
}

function doorOpened(mac: string, extra: object = {}) {
    return {
        name: 'Cửa mở',
        timezone: ZONE,
        trigger: { kind: 'state', mac, property: DOOR_STATE, operator: 'eq', value: 'open' },
        notify_message: 'Cửa chính vừa mở',
        ...extra,
    };
}

function telemetry(mac: string, doorState: string) {
    return {
        owner_id: 'x', mac,
        payload: { schema: 'device.state.patch.v2', state_version: 1, instances: { door_position: { reported: { door_state: doorState } } } },
    };
}

async function row(id: string) {
    return (await db.pool.query('SELECT * FROM automations WHERE id = $1', [id])).rows[0];
}

async function notices(accountId: string) {
    return (await db.pool.query(
        'SELECT title, body FROM account_notifications WHERE account_id = $1 ORDER BY created_at, id',
        [accountId],
    )).rows;
}

async function runsOf(automationId: string) {
    return (await db.pool.query(
        'SELECT trigger, status FROM scene_runs WHERE automation_id = $1 ORDER BY started_at',
        [automationId],
    )).rows;
}

async function setShadow(mac: string, fields: object) {
    await app.mongo.db.collection<any>('device_shadows').updateOne({ _id: mac }, { $set: fields }, { upsert: true });
}

/** Two engines stand for two Gateway instances hearing the same messages. */
async function engines() {
    const first = new AutomationEngine(app);
    const second = new AutomationEngine(app);
    await Promise.all([first.reloadAll(), second.reloadAll()]);
    return {
        both: (handle: (engine: AutomationEngine) => void) => { handle(first); handle(second); },
        idle: () => Promise.all([first.idle(), second.idle()]),
        first,
    };
}

test.describe('automations', { skip: skipWithoutMongo }, () => {
    test.before(async () => {
        db = await createTestDatabase();
        mongo = await new MongoClient(TEST_MONGO_URL).connect();
        app = await buildTestApp(db.pool, [sceneRoutes, automationRoutes, notificationRoutes], {
            client: mongo, db: mongo.db(`automations_${Date.now()}`),
        });
    });
    test.after(async () => {
        await app?.mongo.db.dropDatabase().catch(() => undefined);
        await app?.close();
        await mongo?.close();
        await db?.drop();
    });

    test('options come from the catalog and saving checks devices, comparisons and scenes', async () => {
        const owner = await signUp(app);
        const stranger = await signUp(app);
        const door = await entrance(owner);
        const foreign = await entrance(stranger, 'Nhà khác');

        const options = (await call(owner, 'GET', '/automations/options')).json().devices;
        assert.equal(options.length, 1);
        const doorState = options[0].triggers.find((item: any) => item.property === DOOR_STATE);
        assert.deepEqual(
            { label: doorState.label, kind: doorState.kind, operators: doorState.operators },
            { label: 'Trạng thái cửa', kind: 'enum', operators: ['eq', 'ne'] },
        );
        assert.ok(options[0].events.some((item: any) => item.event === 'pin_auth.pin_access_denied'));
        assert.ok(options[0].conditions.some((item: any) => item.property === 'instances.pin_auth.reported.pin_configured'));
        assert.ok(!options[0].triggers.some((item: any) => item.property === 'instances.pin_auth.reported.pin_configured'));

        const created = await call(owner, 'POST', '/automations', doorOpened(door.mac));
        assert.equal(created.statusCode, 200, created.body);
        const automation = created.json().automation;
        assert.equal(automation.trigger.label, 'Trạng thái cửa');
        assert.equal(automation.trigger.available, true);
        assert.equal(automation.cooldown_seconds, 300);
        assert.equal(automation.scene, null);

        const invalid = async (body: object, code: string) => {
            const response = await call(owner, 'POST', '/automations', body);
            assert.equal(response.json().error?.code, code, response.body);
        };
        await invalid(doorOpened(door.mac), 'AUTOMATION_NAME_TAKEN');
        await invalid(doorOpened(door.mac, { name: 'A', trigger: { kind: 'state', mac: door.mac, property: DOOR_STATE, operator: 'eq', value: 'ajar' } }), 'AUTOMATION_TRIGGER_INVALID');
        await invalid(doorOpened(door.mac, { name: 'B', trigger: { kind: 'state', mac: door.mac, property: 'instances.pin_auth.reported.pin_configured', operator: 'eq', value: true } }), 'AUTOMATION_TRIGGER_INVALID');
        await invalid(doorOpened(door.mac, { name: 'C', trigger: { kind: 'state', mac: door.mac, property: 'instances.door_position.reported.door_angle_degrees', operator: 'eq', value: 30 } }), 'AUTOMATION_TRIGGER_INVALID');
        await invalid(doorOpened(door.mac, { name: 'D', trigger: { kind: 'event', mac: door.mac, event: 'hazard.incident_started' } }), 'AUTOMATION_TRIGGER_INVALID');
        await invalid(doorOpened(door.mac, { name: 'E', conditions: [{ mac: door.mac, property: 'instances.lcd.reported.displayed_lines', operator: 'eq', value: 'x' }] }), 'AUTOMATION_CONDITION_INVALID');
        await invalid(doorOpened(foreign.mac, { name: 'F' }), 'DEVICE_NOT_FOUND');
        await invalid({ ...doorOpened(door.mac, { name: 'G' }), notify_message: null }, 'VALIDATION_ERROR');

        // Nobody can type the password for an automatic run.
        const unlock = await lockScene(owner, door.mac, 'Mở cửa', 'unlock');
        await invalid(doorOpened(door.mac, { name: 'H', scene_id: unlock.id }), 'SCENE_PROTECTED_STEPS');
        const lock = await lockScene(owner, door.mac);
        const withScene = await call(owner, 'PUT', `/automations/${automation.id}`, doorOpened(door.mac, { scene_id: lock.id }));
        assert.equal(withScene.json().automation.scene.name, 'Khóa cửa');
        const protect = await call(owner, 'PATCH', `/scenes/${lock.id}`, {
            steps: [{ mac: door.mac, instance_id: 'main_lock', operation: 'unlock' }],
        });
        assert.equal(protect.json().error?.code, 'SCENE_USED_BY_AUTOMATION');

        // Time trigger: next occurrence from PostgreSQL; off clears it.
        const timed = (await call(owner, 'PUT', `/automations/${automation.id}`, {
            ...doorOpened(door.mac, { scene_id: lock.id }),
            trigger: { kind: 'time', time: '23:00', days: [7, 1, 1] },
        })).json().automation;
        assert.deepEqual(timed.trigger, { kind: 'time', time: '23:00', days: [1, 7] });
        assert.ok(timed.next_run_at);
        const off = (await call(owner, 'PATCH', `/automations/${automation.id}`, { enabled: false })).json().automation;
        assert.equal(off.enabled, false);
        assert.equal(off.next_run_at, null);

        assert.equal((await call(stranger, 'DELETE', `/automations/${automation.id}`)).statusCode, 404);
        await call(owner, 'DELETE', `/scenes/${lock.id}`);
        assert.equal((await call(owner, 'GET', '/automations')).json().automations[0].scene, null);
        assert.equal((await call(owner, 'DELETE', `/automations/${automation.id}`)).statusCode, 200);
        assert.equal((await call(owner, 'GET', '/automations')).json().automations.length, 0);
    });

    test('a state trigger acts once per false → true, across Gateway instances and the cooldown', async () => {
        const owner = await signUp(app);
        const door = await entrance(owner);
        const scene = await lockScene(owner, door.mac);
        const automation = (await call(owner, 'POST', '/automations', doorOpened(door.mac, { scene_id: scene.id }))).json().automation;
        const published = recordPublishes(app);
        const gateways = await engines();

        gateways.both(engine => engine.handleTelemetry(telemetry(door.mac, 'open')));
        await gateways.idle();
        assert.deepEqual(await runsOf(automation.id), [{ trigger: 'automation', status: 'running' }]);
        assert.deepEqual(await notices(owner.id), [{ title: 'Cửa mở', body: 'Cửa chính vừa mở' }]);
        assert.equal((await row(automation.id)).last_result, 'started');
        const events = published.filter(item => item.channel === REDIS_CHANNELS.ACCOUNT_EVENT).map(item => item.payload.event);
        assert.ok(events.includes('automation_fired') && events.includes('notification_created'), events.join());

        // Still open: nothing new. Closed then open within the cooldown: nothing either.
        gateways.both(engine => engine.handleTelemetry(telemetry(door.mac, 'open')));
        gateways.both(engine => engine.handleTelemetry(telemetry(door.mac, 'closed')));
        await gateways.idle();
        assert.equal((await row(automation.id)).trigger_matched, false);
        gateways.both(engine => engine.handleTelemetry(telemetry(door.mac, 'open')));
        await gateways.idle();
        assert.equal((await notices(owner.id)).length, 1);
        assert.equal((await row(automation.id)).trigger_matched, true);

        // After the cooldown: acts again; the first run is still going, so only the notification goes out.
        await db.pool.query(`UPDATE automations SET last_acted_at = NOW() - interval '10 minutes' WHERE id = $1`, [automation.id]);
        gateways.both(engine => engine.handleTelemetry(telemetry(door.mac, 'closed')));
        gateways.both(engine => engine.handleTelemetry(telemetry(door.mac, 'open')));
        await gateways.idle();
        assert.equal((await notices(owner.id)).length, 2);
        assert.equal((await runsOf(automation.id)).length, 1);
        assert.equal((await row(automation.id)).last_result, 'skipped_running');

        // Outside the active window: recorded, nothing done.
        await db.pool.query(
            `UPDATE automations SET last_acted_at = NULL,
                    active_from = date_trunc('minute', (NOW() AT TIME ZONE timezone) + interval '2 hours')::time,
                    active_to = date_trunc('minute', (NOW() AT TIME ZONE timezone) + interval '3 hours')::time
             WHERE id = $1`,
            [automation.id],
        );
        gateways.both(engine => engine.handleTelemetry(telemetry(door.mac, 'closed')));
        gateways.both(engine => engine.handleTelemetry(telemetry(door.mac, 'open')));
        await gateways.idle();
        assert.equal((await row(automation.id)).last_result, 'skipped_conditions');
        assert.equal((await notices(owner.id)).length, 2);
    });

    test('event and connectivity triggers; a device without automations is skipped before parsing', async () => {
        const owner = await signUp(app);
        const door = await entrance(owner);
        const camera = await createOwnedDevice(db.pool, owner.id, { name: 'Camera cổng' });
        const pin = (await call(owner, 'POST', '/automations', {
            name: 'Sai PIN', timezone: ZONE, notify_message: 'Có người nhập sai PIN',
            trigger: { kind: 'event', mac: door.mac, event: 'pin_auth.pin_access_denied' },
        })).json().automation;
        const offline = (await call(owner, 'POST', '/automations', {
            name: 'Camera mất kết nối', timezone: ZONE, notify_message: 'Camera cổng vừa mất kết nối',
            trigger: { kind: 'state', mac: camera.mac, property: 'diagnostics.system.online', operator: 'eq', value: false },
        })).json().automation;
        const gateways = await engines();
        const event = (id: string) => ({
            owner_id: 'x', mac: door.mac,
            payload: { event_id: id, instance_id: 'pin_auth', event_name: 'pin_access_denied' },
        });
        gateways.both(engine => engine.handleEvent(event('evt-1')));
        await gateways.idle();
        gateways.both(engine => engine.handleEvent(event('evt-2')));
        gateways.both(engine => engine.handleEvent({ ...event('evt-3'), payload: { ...event('evt-3').payload, event_name: 'pin_access_granted' } }));
        await gateways.idle();
        assert.deepEqual((await notices(owner.id)).map(item => item.title), ['Sai PIN']);
        assert.equal((await row(pin.id)).last_event_id, 'evt-2');

        gateways.both(engine => engine.handleStatus({ mac: camera.mac, payload: { is_online: true } }));
        gateways.both(engine => engine.handleStatus({ mac: camera.mac, payload: { is_online: false } }));
        await gateways.idle();
        assert.deepEqual((await notices(owner.id)).map(item => item.title), ['Sai PIN', 'Camera mất kết nối']);
        assert.equal((await row(offline.id)).last_result, 'notified');

        // Raw Redis messages: a device without automations never reaches JSON.parse.
        const unknown = JSON.stringify(telemetry('AA:BB:CC:DD:EE:FF', 'open'));
        const known = JSON.stringify(telemetry(door.mac, 'open'));
        const parse = JSON.parse;
        let parsed = 0;
        JSON.parse = ((text: string, reviver?: any) => { parsed += 1; return parse(text, reviver); }) as typeof JSON.parse;
        try {
            (gateways.first as any).dispatch(REDIS_CHANNELS.DEVICE_TELEMETRY, unknown);
            assert.equal(parsed, 0);
            (gateways.first as any).dispatch(REDIS_CHANNELS.DEVICE_TELEMETRY, known);
            assert.equal(parsed, 1);
        } finally {
            JSON.parse = parse;
        }
    });

    test('time triggers check conditions on current state; late ones are missed; lost access stops them', async () => {
        const owner = await signUp(app);
        const member = await signUp(app);
        const door = await entrance(owner);
        await addMember(db.pool, door, owner.id, member.id, 'viewer', ['device.view']);
        const scene = await lockScene(owner, door.mac);
        const nightly = (await call(owner, 'POST', '/automations', {
            name: 'Tự khóa 23:00', timezone: ZONE, scene_id: scene.id, notify_message: 'Cửa chưa khóa, đã khóa lại',
            trigger: { kind: 'time', time: '23:00', days: [1, 2, 3, 4, 5, 6, 7] },
            conditions: [{ mac: door.mac, property: LOCK_STATE, operator: 'ne', value: 'locked' }],
        })).json().automation;
        const watch = (await call(member, 'POST', '/automations', doorOpened(door.mac, { name: 'Cửa (thành viên)' }))).json().automation;
        const due = (id: string, ago = '1 minute') =>
            db.pool.query(`UPDATE automations SET next_run_at = NOW() - $2::interval WHERE id = $1`, [id, ago]);

        await setShadow(door.mac, { 'instances.main_lock.reported.lock_state': 'unlocked' });
        await due(nightly.id);
        assert.equal(await runDueAutomations(app), 1);
        let current = await row(nightly.id);
        assert.equal(current.last_result, 'started');
        assert.ok(current.next_run_at > new Date());
        assert.equal((await runsOf(nightly.id)).length, 1);

        await setShadow(door.mac, { 'instances.main_lock.reported.lock_state': 'locked' });
        await due(nightly.id);
        await runDueAutomations(app);
        assert.equal((await row(nightly.id)).last_result, 'skipped_conditions');

        await due(nightly.id, '20 minutes');
        await runDueAutomations(app);
        current = await row(nightly.id);
        assert.equal(current.last_result, 'missed');
        assert.equal(await runDueAutomations(app), 0);
        assert.equal((await notices(owner.id)).length, 1);

        // The member's automation stops working once the device is no longer shared.
        await db.pool.query('DELETE FROM device_membership_permissions WHERE account_id = $1', [member.id]);
        await db.pool.query('DELETE FROM device_memberships WHERE account_id = $1', [member.id]);
        const gateways = await engines();
        gateways.both(engine => engine.handleTelemetry(telemetry(door.mac, 'open')));
        await gateways.idle();
        assert.equal((await row(watch.id)).last_result, 'unavailable');
        assert.equal((await notices(member.id)).length, 0);
        const view = (await call(member, 'GET', '/automations')).json().automations[0];
        assert.equal(view.trigger.available, false);
    });

    test('suggestions fit the devices and permissions and are added once', async () => {
        const owner = await signUp(app);
        const member = await signUp(app);
        const door = await entrance(owner);
        await createOwnedDevice(db.pool, owner.id, { name: 'Bếp', productId: 'prod_hazard_mitigation', catalogRevision: 6 });
        await createOwnedDevice(db.pool, owner.id, { name: 'Mái', productId: 'prod_roof_controller', catalogRevision: 2 });
        await createOwnedDevice(db.pool, owner.id, { name: 'Vườn', productId: 'prod_irrigation_manager', catalogRevision: 2 });
        await addMember(db.pool, door, owner.id, member.id, 'viewer', ['device.view']);

        const list = (await call(owner, 'GET', '/automations/suggestions')).json().suggestions;
        assert.deepEqual(list.map((item: any) => item.template).sort(),
            ['gas_vent', 'night_door', 'night_lock', 'offline', 'rain_stop']);
        // A viewer may be told about the door, not lock it.
        assert.deepEqual((await call(member, 'GET', '/automations/suggestions')).json().suggestions
            .map((item: any) => item.template), ['night_door']);

        const key = list.find((item: any) => item.template === 'night_lock').key;
        const applied = await call(owner, 'POST', '/automations/suggestions/apply', { key, timezone: ZONE });
        assert.equal(applied.statusCode, 200, applied.body);
        const automation = applied.json().automation;
        assert.equal(applied.json().scene_created, true);
        assert.equal(automation.trigger.kind, 'time');
        assert.equal(automation.conditions[0].property, LOCK_STATE);
        assert.equal(automation.scene.name, 'Khóa Cửa chính');
        assert.ok(!(await call(owner, 'GET', '/automations/suggestions')).json().suggestions
            .some((item: any) => item.key === key));
        const again = await call(owner, 'POST', '/automations/suggestions/apply', { key, timezone: ZONE });
        assert.equal(again.json().error?.code, 'SUGGESTION_ALREADY_ADDED');
        const unknown = await call(owner, 'POST', '/automations/suggestions/apply', { key: 'night_lock:00:00:00:00:00:00', timezone: ZONE });
        assert.equal(unknown.statusCode, 404);
    });

    test('automation notifications merge into the notification center in order', async () => {
        const owner = await signUp(app);
        const kitchen = await createOwnedDevice(db.pool, owner.id, { name: 'Bếp', productId: 'prod_hazard_mitigation', catalogRevision: 6 });
        const base = Date.parse('2026-11-08T08:00:00Z');
        const at = (minutes: number) => new Date(base + minutes * 60_000);
        for (const minutes of [1, 3]) {
            await app.mongo.db.collection('device_events').insertOne({
                _id: new ObjectId(), event_id: `gas-${minutes}`, device_id: kitchen.mac,
                capability_id: 'gas_measurement', instance_id: 'kitchen_gas', event_name: 'gas_threshold_crossed',
                severity: 'critical', data: {}, occurred_at: at(minutes), received_at: at(minutes),
            } as any);
        }
        for (const minutes of [2, 3, 4]) {
            await db.pool.query(
                `INSERT INTO account_notifications (account_id, title, body, created_at) VALUES ($1, $2, 'x', $3)`,
                [owner.id, `Tự động ${minutes}`, at(minutes)],
            );
        }
        const seen: string[] = [];
        let cursor: string | null = null;
        do {
            const page: any = (await call(owner, 'GET', `/me/notifications?limit=2${cursor ? `&before=${cursor}` : ''}`)).json();
            seen.push(...page.items.map((item: any) => item.kind === 'automation' ? item.title : `gas ${item.at.slice(14, 16)}`));
            cursor = page.next_cursor;
        } while (cursor);
        assert.deepEqual(seen, ['Tự động 4', 'gas 03', 'Tự động 3', 'Tự động 2', 'gas 01']);
        assert.equal((await call(owner, 'GET', '/me/badges')).json().notifications, 5);
    });
});
