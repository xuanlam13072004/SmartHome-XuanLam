import './setup-env';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { MongoClient, ObjectId } from 'mongodb';
import accountRoutes from '../src/modules/account/routes';
import notificationRoutes from '../src/modules/notifications/routes';
import { buildNotificationFilter } from '../src/modules/notifications/filter';
import { createTestDatabase, skipWithoutMongo, TEST_MONGO_URL, TestDatabase } from './helpers/testDatabase';
import { buildTestApp, signUp } from './helpers/testApp';
import { addMember, createOwnedDevice } from './helpers/fixtures';

let db: TestDatabase;
let app: FastifyInstance;
let mongo: MongoClient;

test('the filter scopes members to events after they joined and drops muted categories', () => {
    const joined = new Date('2026-11-08T10:00:00Z');
    const filter = buildNotificationFilter({
        devices: [
            { mac: 'AA:00:00:00:00:01', name: 'A', owner: true, joined_at: new Date(0) },
            { mac: 'AA:00:00:00:00:02', name: 'B', owner: false, joined_at: joined },
        ],
        muted: ['camera'],
    }) as any;
    assert.deepEqual(filter.$and[0], {
        $or: [
            { device_id: { $in: ['AA:00:00:00:00:01'] } },
            { device_id: 'AA:00:00:00:00:02', received_at: { $gte: joined } },
        ],
    });
    assert.deepEqual(filter.$and[1], { severity: { $in: ['warning', 'critical'] } });
    assert.deepEqual(filter.$and[2], { capability_id: { $nin: ['camera_stream', 'video_recording'] } });
    assert.equal(buildNotificationFilter({ devices: [], muted: [] }), null);
});

test.describe('notification center', { skip: skipWithoutMongo }, () => {
    test.before(async () => {
        db = await createTestDatabase();
        mongo = await new MongoClient(TEST_MONGO_URL).connect();
        const mongoDb = mongo.db(`notifications_${Date.now()}`);
        app = await buildTestApp(db.pool, [accountRoutes, notificationRoutes], { client: mongo, db: mongoDb });
    });
    test.after(async () => {
        await app?.close();
        await mongo?.close();
        await db?.drop();
    });

    let sequence = 0;
    async function event(mac: string, capability: string, name: string, severity: string, receivedAt: Date) {
        sequence += 1;
        await app.mongo.db.collection('device_events').insertOne({
            _id: new ObjectId(),
            event_id: `evt-${sequence}`,
            device_id: mac,
            capability_id: capability,
            instance_id: capability,
            event_name: name,
            severity,
            data: {},
            occurred_at: receivedAt,
            received_at: receivedAt,
        } as any);
    }

    test('lists warnings of visible devices, honours mutes, pages and badges', async () => {
        const owner = await signUp(app);
        const member = await signUp(app);
        const kitchen = await createOwnedDevice(db.pool, owner.id, { name: 'Bếp', productId: 'prod_hazard_mitigation' });
        const camera = await createOwnedDevice(db.pool, owner.id, { name: 'Camera', productId: 'prod_security_camera' });
        const stranger = await signUp(app);
        const foreign = await createOwnedDevice(db.pool, stranger.id, { name: 'Nhà khác' });

        const base = Date.parse('2026-11-08T08:00:00Z');
        await event(kitchen.mac, 'smoke_measurement', 'smoke_threshold_crossed', 'critical', new Date(base));
        await event(kitchen.mac, 'local_button', 'button_pressed', 'info', new Date(base + 1000));
        await event(camera.mac, 'video_recording', 'storage_fault', 'warning', new Date(base + 2000));
        await event(foreign.mac, 'smoke_measurement', 'smoke_threshold_crossed', 'critical', new Date(base + 3000));

        const list = (await app.inject({ method: 'GET', url: '/me/notifications', headers: owner.headers })).json();
        assert.deepEqual(list.items.map((item: any) => [item.device.name, item.event_name, item.category]), [
            ['Camera', 'storage_fault', 'camera'],
            ['Bếp', 'smoke_threshold_crossed', 'safety'],
        ]);
        assert.ok(list.items.every((item: any) => item.unread));

        const badges = (await app.inject({ method: 'GET', url: '/me/badges', headers: owner.headers })).json();
        assert.deepEqual({ notifications: badges.notifications, invites: badges.invites }, { notifications: 2, invites: 0 });
        await app.inject({ method: 'POST', url: '/me/notifications/seen', headers: owner.headers });
        assert.equal((await app.inject({ method: 'GET', url: '/me/badges', headers: owner.headers })).json().notifications, 0);

        const muteSafety = await app.inject({
            method: 'PATCH', url: '/me/preferences', headers: owner.headers,
            payload: { muted_notification_categories: ['safety'] },
        });
        assert.equal(muteSafety.statusCode, 400, 'fire and gas alerts cannot be muted');
        const muted = await app.inject({
            method: 'PATCH', url: '/me/preferences', headers: owner.headers,
            payload: { muted_notification_categories: ['camera'] },
        });
        assert.deepEqual(muted.json().muted_notification_categories, ['camera']);
        const filtered = (await app.inject({ method: 'GET', url: '/me/notifications', headers: owner.headers })).json();
        assert.deepEqual(filtered.items.map((item: any) => item.event_name), ['smoke_threshold_crossed']);
        assert.equal(filtered.items[0].unread, false);

        const firstPage = (await app.inject({ method: 'GET', url: '/me/notifications?limit=1', headers: stranger.headers })).json();
        assert.equal(firstPage.items.length, 1);
        assert.equal(firstPage.next_cursor, null);

        // A member sees only what happened after joining.
        await db.pool.query(`SELECT 1`);
        await addMember(db.pool, kitchen, owner.id, member.id);
        await event(kitchen.mac, 'gas_measurement', 'gas_threshold_crossed', 'critical', new Date(Date.now() + 1000));
        const memberList = (await app.inject({ method: 'GET', url: '/me/notifications', headers: member.headers })).json();
        assert.deepEqual(memberList.items.map((item: any) => item.event_name), ['gas_threshold_crossed']);
    });

    test('pages through many notifications with a stable cursor', async () => {
        const owner = await signUp(app);
        const device = await createOwnedDevice(db.pool, owner.id, { productId: 'prod_entrance_controller' });
        const at = new Date('2026-11-08T12:00:00Z');
        for (let i = 0; i < 7; i++) await event(device.mac, 'pin_authentication', 'pin_access_denied', 'warning', at);
        const ids: string[] = [];
        let cursor: string | null = null;
        do {
            const url: string = `/me/notifications?limit=3${cursor ? `&before=${cursor}` : ''}`;
            const page: any = (await app.inject({ method: 'GET', url, headers: owner.headers })).json();
            ids.push(...page.items.map((item: any) => item.id));
            cursor = page.next_cursor;
        } while (cursor);
        assert.equal(ids.length, 7);
        assert.equal(new Set(ids).size, 7);
    });
});
