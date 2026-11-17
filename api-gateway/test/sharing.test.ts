import './setup-env';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { REDIS_CHANNELS } from '../../shared/constants';
import accountRoutes from '../src/modules/account/routes';
import sharingRoutes from '../src/modules/sharing/routes';
import { createTestDatabase, skipWithoutDatabase, TestDatabase } from './helpers/testDatabase';
import { buildTestApp, recordPublishes, signUp, SignedInUser } from './helpers/testApp';
import { createOwnedDevice } from './helpers/fixtures';

let db: TestDatabase;
let app: FastifyInstance;
let published: Array<{ channel: string; payload: any }>;

const call = (user: SignedInUser, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, headers: user.headers, ...(payload ? { payload } : {}) });

const invite = (owner: SignedInUser, mac: string, email: string, role = 'viewer', permissions?: string[]) =>
    call(owner, 'POST', `/devices/${mac}/invites`, { email, role, ...(permissions ? { permissions } : {}) });

async function permissionsOf(deviceId: string, accountId: string): Promise<string[]> {
    const result = await db.pool.query(
        `SELECT permission_scope FROM device_membership_permissions
         WHERE device_id = $1 AND account_id = $2 ORDER BY permission_scope`,
        [deviceId, accountId],
    );
    return result.rows.map(row => row.permission_scope);
}

async function latestAccessGrants(deviceId: string): Promise<Array<{ account_id: string; role: string; permissions: string[] }>> {
    const result = await db.pool.query(
        `SELECT payload FROM device_shadow_outbox
         WHERE device_id = $1 AND operation = 'access' ORDER BY id DESC LIMIT 1`,
        [deviceId],
    );
    return result.rows[0]?.payload.access_grants ?? [];
}

test.describe('device sharing', { skip: skipWithoutDatabase }, () => {
    test.before(async () => {
        db = await createTestDatabase();
        app = await buildTestApp(db.pool, [accountRoutes, sharingRoutes]);
        published = recordPublishes(app);
    });
    test.after(async () => {
        await app?.close();
        await db?.drop();
    });

    test('an invitation to a future account waits for it, then grants the viewer preset', async () => {
        const owner = await signUp(app, { fullName: 'Chủ Nhà' });
        const device = await createOwnedDevice(db.pool, owner.id, { name: 'Cửa chính', productId: 'prod_entrance_controller' });
        const email = `friend.${Date.now()}@example.com`;

        const sent = await invite(owner, device.mac.toLowerCase(), email.toUpperCase());
        assert.equal(sent.statusCode, 200, sent.body);
        assert.deepEqual(sent.json().invite.permissions, ['device.view']);

        const friend = await signUp(app, { email, fullName: 'Bạn Bè' });
        const overview = (await call(friend, 'GET', '/me')).json();
        assert.equal(overview.stats.pending_invites, 1);
        const sharing = (await call(friend, 'GET', '/me/sharing')).json();
        assert.equal(sharing.invites.length, 1);
        assert.deepEqual(sharing.invites[0].device, { mac: device.mac, name: 'Cửa chính', product_id: 'prod_entrance_controller' });
        assert.deepEqual(sharing.invites[0].owner, { full_name: 'Chủ Nhà', email: owner.email });

        published.length = 0;
        const accepted = await call(friend, 'POST', `/me/invites/${sharing.invites[0].id}/accept`);
        assert.equal(accepted.statusCode, 200, accepted.body);
        assert.deepEqual(accepted.json().device, { mac: device.mac, name: 'Cửa chính' });

        assert.deepEqual(await permissionsOf(device.id, friend.id), ['device.view']);
        const grants = await latestAccessGrants(device.id);
        assert.deepEqual(grants.map(grant => [grant.account_id, grant.role]), [[owner.id, 'owner'], [friend.id, 'viewer']]);
        assert.deepEqual(grants[0].permissions, ['credential.manage', 'device.view', 'display.write', 'door.control']);

        const access = published.find(item => item.channel === REDIS_CHANNELS.DEVICE_ACCESS_CHANGED);
        assert.deepEqual(access?.payload, { mac: device.mac, access_account_ids: [owner.id, friend.id], removed_account_ids: [] });
        const joined = published.find(item => item.channel === REDIS_CHANNELS.ACCOUNT_EVENT);
        assert.deepEqual(joined?.payload, {
            account_id: owner.id,
            event: 'sharing_member_joined',
            data: { device_name: 'Cửa chính', member_name: 'Bạn Bè' },
        });

        const after = (await call(friend, 'GET', '/me/sharing')).json();
        assert.equal(after.invites.length, 0);
        assert.equal(after.shared_with_me[0].device.mac, device.mac);
        assert.equal(after.shared_with_me[0].role, 'viewer');
        assert.equal((await call(friend, 'GET', '/me')).json().stats.shared_devices, 1);
        const ownerSharing = (await call(owner, 'GET', '/me/sharing')).json();
        assert.deepEqual(ownerSharing.my_devices.map((item: any) => [item.device.name, item.member_count]), [['Cửa chính', 1]]);
    });

    test('the owner sees members and invitations, changes a role and removes a member', async () => {
        const owner = await signUp(app);
        const device = await createOwnedDevice(db.pool, owner.id, { productId: 'prod_entrance_controller' });
        const member = await signUp(app);
        const id = (await invite(owner, device.mac, member.email)).json().invite.id;
        await call(member, 'POST', `/me/invites/${id}/accept`);
        await invite(owner, device.mac, 'pending.person@example.com', 'controller');

        const list = (await call(owner, 'GET', `/devices/${device.mac}/members`)).json();
        assert.deepEqual(list.members.map((m: any) => [m.email, m.role]), [[member.email, 'viewer']]);
        assert.deepEqual(list.invites.map((i: any) => [i.email, i.role]), [['pending.person@example.com', 'controller']]);
        assert.deepEqual(list.role_permissions, {
            viewer: ['device.view'],
            controller: ['device.view', 'display.write', 'door.control'],
        });
        assert.deepEqual(list.limits, { max_members: 10, used: 2 });

        const promoted = await call(owner, 'PATCH', `/devices/${device.mac}/members/${member.id}`, { role: 'controller' });
        assert.equal(promoted.statusCode, 200, promoted.body);
        assert.deepEqual(await permissionsOf(device.id, member.id), ['device.view', 'display.write', 'door.control']);

        const custom = await call(owner, 'PATCH', `/devices/${device.mac}/members/${member.id}`, {
            role: 'controller', permissions: ['door.control'],
        });
        assert.equal(custom.statusCode, 200);
        assert.deepEqual(await permissionsOf(device.id, member.id), ['device.view', 'door.control']);

        const ownerOnly = await call(owner, 'PATCH', `/devices/${device.mac}/members/${member.id}`, {
            role: 'controller', permissions: ['credential.manage'],
        });
        assert.equal(ownerOnly.json().error.code, 'PERMISSION_NOT_SHAREABLE');

        published.length = 0;
        const removed = await call(owner, 'DELETE', `/devices/${device.mac}/members/${member.id}`);
        assert.equal(removed.statusCode, 200);
        assert.deepEqual(await permissionsOf(device.id, member.id), []);
        assert.deepEqual((await latestAccessGrants(device.id)).map(grant => grant.account_id), [owner.id]);
        assert.deepEqual(
            published.find(item => item.channel === REDIS_CHANNELS.DEVICE_ACCESS_CHANGED)?.payload.removed_account_ids,
            [member.id],
        );
    });

    test('removing a member revokes their open camera session on that device', async () => {
        const owner = await signUp(app);
        const camera = await createOwnedDevice(db.pool, owner.id, { productId: 'prod_security_camera' });
        const member = await signUp(app);
        await call(member, 'POST', `/me/invites/${(await invite(owner, camera.mac, member.email)).json().invite.id}/accept`);
        assert.deepEqual(await permissionsOf(camera.id, member.id), ['camera.view', 'device.view']);

        const operation = await db.pool.query(
            `INSERT INTO device_operations
                (device_id, actor_account_id, instance_id, operation_name, permission_scope, risk, catalog_revision, timeout_at)
             VALUES ($1, $2, 'camera', 'create_stream_session', 'camera.view', 'sensitive', 1, NOW() + INTERVAL '1 minute')
             RETURNING id`,
            [camera.id, member.id],
        );
        const session = await db.pool.query(
            `INSERT INTO device_resource_sessions
                (device_id, actor_account_id, operation_id, instance_id, resource_id, permission_scope,
                 resource_kind, status, access_token_hash, resource_locator, ready_at, expires_at)
             VALUES ($1, $2, $3, 'camera', 'live_stream', 'camera.view', 'video_stream', 'ready', 'hash',
                     'http://relay/v1/sessions/x/', NOW(), NOW() + INTERVAL '5 minutes')
             RETURNING id`,
            [camera.id, member.id, operation.rows[0].id],
        );
        published.length = 0;
        await call(owner, 'DELETE', `/devices/${camera.mac}/members/${member.id}`);
        const status = await db.pool.query('SELECT status FROM device_resource_sessions WHERE id = $1', [session.rows[0].id]);
        assert.equal(status.rows[0].status, 'revoked');
        const relay = published.find(item => item.channel === REDIS_CHANNELS.MEDIA_SESSION_REVOKED);
        assert.deepEqual(relay?.payload.session_ids, [session.rows[0].id]);
    });

    test('invitations are refused for yourself, existing members, duplicates and beyond the limit', async () => {
        const owner = await signUp(app);
        const device = await createOwnedDevice(db.pool, owner.id);
        assert.equal((await invite(owner, device.mac, owner.email)).json().error.code, 'CANNOT_INVITE_SELF');
        assert.equal((await invite(owner, device.mac, 'dup@example.com')).statusCode, 200);
        assert.equal((await invite(owner, device.mac, 'dup@example.com')).json().error.code, 'INVITE_ALREADY_PENDING');
        assert.equal((await invite(owner, device.mac, 'x@example.com', 'viewer', ['camera.recording.manage'])).json().error.code,
            'PERMISSION_NOT_SHAREABLE');
        for (let i = 0; i < 9; i++) assert.equal((await invite(owner, device.mac, `seat${i}@example.com`)).statusCode, 200);
        assert.equal((await invite(owner, device.mac, 'eleventh@example.com')).json().error.code, 'MEMBER_LIMIT_REACHED');

        const stranger = await signUp(app);
        assert.equal((await invite(stranger, device.mac, 'y@example.com')).statusCode, 404);
        assert.equal((await call(stranger, 'GET', `/devices/${device.mac}/members`)).statusCode, 404);
    });

    test('a member cannot manage sharing, can leave, and an owner cannot leave', async () => {
        const owner = await signUp(app);
        const device = await createOwnedDevice(db.pool, owner.id);
        const member = await signUp(app);
        await call(member, 'POST', `/me/invites/${(await invite(owner, device.mac, member.email)).json().invite.id}/accept`);
        assert.equal(
            (await invite(member, device.mac, 'z@example.com')).json().error.code,
            'NOT_DEVICE_OWNER',
        );
        assert.equal((await call(owner, 'DELETE', `/devices/${device.mac}/membership`)).json().error.code, 'OWNER_CANNOT_LEAVE');
        assert.equal((await call(member, 'DELETE', `/devices/${device.mac}/membership`)).statusCode, 200);
        assert.equal((await call(member, 'GET', '/me')).json().stats.shared_devices, 0);
        assert.equal((await call(member, 'DELETE', `/devices/${device.mac}/membership`)).statusCode, 404);
    });

    test('declined, cancelled and expired invitations cannot be accepted; an expired one can be re-sent', async () => {
        const owner = await signUp(app);
        const device = await createOwnedDevice(db.pool, owner.id);
        const friend = await signUp(app);

        const first = (await invite(owner, device.mac, friend.email)).json().invite.id;
        assert.equal((await call(friend, 'POST', `/me/invites/${first}/decline`)).statusCode, 200);
        assert.equal((await call(friend, 'POST', `/me/invites/${first}/accept`)).json().error.code, 'INVITE_NOT_PENDING');

        published.length = 0;
        const second = (await invite(owner, device.mac, friend.email)).json().invite.id;
        assert.deepEqual(
            published.find(item => item.channel === REDIS_CHANNELS.ACCOUNT_EVENT)?.payload.event,
            'sharing_invite_received',
        );
        assert.equal((await call(owner, 'DELETE', `/devices/${device.mac}/invites/${second}`)).statusCode, 200);
        assert.equal((await call(friend, 'POST', `/me/invites/${second}/accept`)).json().error.code, 'INVITE_NOT_PENDING');

        const third = (await invite(owner, device.mac, friend.email)).json().invite.id;
        await db.pool.query(
            `UPDATE device_invites SET created_at = NOW() - INTERVAL '8 days', expires_at = NOW() - INTERVAL '1 day' WHERE id = $1`,
            [third],
        );
        assert.equal((await call(friend, 'POST', `/me/invites/${third}/accept`)).json().error.code, 'INVITE_EXPIRED');
        await db.pool.query(`UPDATE device_invites SET status = 'pending' WHERE id = $1`, [third]);
        assert.equal((await invite(owner, device.mac, friend.email)).statusCode, 200, 'a lapsed invitation does not block a new one');

        const stranger = await signUp(app);
        assert.equal((await call(stranger, 'POST', `/me/invites/${third}/accept`)).statusCode, 404, 'only the invitee can answer');

        const actions = await db.pool.query(
            `SELECT action FROM device_audit_logs WHERE device_id = $1 ORDER BY id`,
            [device.id],
        );
        assert.deepEqual(actions.rows.map(row => row.action), [
            'sharing.invite_sent', 'sharing.invite_declined', 'sharing.invite_sent',
            'sharing.invite_cancelled', 'sharing.invite_sent', 'sharing.invite_sent',
        ]);
    });
});
