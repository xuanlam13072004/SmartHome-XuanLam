import './setup-env';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import accountRoutes from '../src/modules/account/routes';
import notificationRoutes from '../src/modules/notifications/routes';
import sharingRoutes from '../src/modules/sharing/routes';
import { createTestDatabase, skipWithoutDatabase, TestDatabase } from './helpers/testDatabase';
import { buildTestApp, signUp } from './helpers/testApp';
import { createOwnedDevice } from './helpers/fixtures';

let db: TestDatabase;
let app: FastifyInstance;

test.describe('activity history', { skip: skipWithoutDatabase }, () => {
    test.before(async () => {
        db = await createTestDatabase();
        app = await buildTestApp(db.pool, [accountRoutes, sharingRoutes, notificationRoutes]);
    });
    test.after(async () => {
        await app?.close();
        await db?.drop();
    });

    async function operation(deviceId: string, actorId: string, name: string, instance: string, createdAt: string) {
        await db.pool.query(
            `INSERT INTO device_operations
                (device_id, actor_account_id, instance_id, operation_name, permission_scope, risk,
                 catalog_revision, status, accepted_at, created_at, completed_at, timeout_at)
             VALUES ($1, $2, $3, $4, 'device.view', 'normal', 1, 'succeeded', $5, $5, $5, $5::timestamptz + INTERVAL '1 minute')`,
            [deviceId, actorId, instance, name, createdAt],
        );
    }

    test('device commands and account changes are merged newest first, without query operations', async () => {
        const user = await signUp(app);
        const camera = await createOwnedDevice(db.pool, user.id, { name: 'Camera cổng', productId: 'prod_security_camera' });
        await operation(camera.id, user.id, 'create_stream_session', 'camera', '2026-11-08T08:00:00Z');
        await operation(camera.id, user.id, 'list_recordings', 'recording', '2026-11-08T08:01:00Z');
        await app.inject({ method: 'PATCH', url: '/me', headers: user.headers, payload: { full_name: 'Tên Mới' } });

        const response = await app.inject({ method: 'GET', url: '/me/activity', headers: user.headers });
        assert.equal(response.statusCode, 200);
        const items = response.json().items;
        assert.deepEqual(items.map((item: any) => item.action), ['account.profile_updated', 'create_stream_session']);
        assert.equal(items[0].metadata.full_name, 'Tên Mới');
        assert.equal(items[1].label, 'Xem trực tiếp');
        assert.deepEqual(items[1].device, { mac: camera.mac, name: 'Camera cổng', product_id: 'prod_security_camera' });
    });

    test('pages follow the cursor without gaps or repeats, even with equal timestamps', async () => {
        const user = await signUp(app);
        const device = await createOwnedDevice(db.pool, user.id, { productId: 'prod_roof_controller' });
        const sameTime = '2026-11-08T09:00:00.123456Z';
        for (let i = 0; i < 4; i++) await operation(device.id, user.id, 'stop', 'roof_motor', sameTime);
        for (let i = 0; i < 3; i++) {
            await db.pool.query(
                `INSERT INTO device_audit_logs (actor_account_id, action, outcome, occurred_at)
                 VALUES ($1, 'account.profile_updated', 'success', $2)`,
                [user.id, sameTime],
            );
        }
        for (let i = 0; i < 3; i++) {
            await operation(device.id, user.id, 'open', 'roof_motor', `2026-11-08T0${i + 1}:00:00Z`);
        }

        const seen: string[] = [];
        let cursor: string | null = null;
        let pages = 0;
        do {
            const url: string = `/me/activity?limit=3${cursor ? `&before=${cursor}` : ''}`;
            const page: any = (await app.inject({ method: 'GET', url, headers: user.headers })).json();
            seen.push(...page.items.map((item: any) => `${item.kind}:${item.id}`));
            cursor = page.next_cursor;
            pages += 1;
        } while (cursor && pages < 10);

        assert.equal(seen.length, 10);
        assert.equal(new Set(seen).size, 10, 'no item repeats');
        assert.equal(pages, 4);
    });

    test('device management and sharing actions are recorded for the actor', async () => {
        const owner = await signUp(app);
        const device = await createOwnedDevice(db.pool, owner.id, { name: 'Mái che' });
        await app.inject({
            method: 'POST', url: `/devices/${device.mac}/invites`, headers: owner.headers,
            payload: { email: 'guest@example.com', role: 'viewer' },
        });
        const items = (await app.inject({ method: 'GET', url: '/me/activity', headers: owner.headers })).json().items;
        assert.equal(items[0].action, 'sharing.invite_sent');
        assert.deepEqual(items[0].metadata, { device_name: 'Mái che', email: 'guest@example.com', role: 'viewer' });
        assert.equal(items[0].device.name, 'Mái che');
    });

    test('a malformed cursor is rejected', async () => {
        const user = await signUp(app);
        const response = await app.inject({ method: 'GET', url: '/me/activity?before=not-a-cursor', headers: user.headers });
        assert.equal(response.statusCode, 400);
        assert.equal(response.json().error.code, 'INVALID_CURSOR');
    });
});
