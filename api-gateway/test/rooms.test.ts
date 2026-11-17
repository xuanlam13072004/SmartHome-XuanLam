import './setup-env';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import accountRoutes from '../src/modules/account/routes';
import roomRoutes from '../src/modules/rooms/routes';
import sharingRoutes from '../src/modules/sharing/routes';
import { createTestDatabase, skipWithoutDatabase, TestDatabase } from './helpers/testDatabase';
import { buildTestApp, signUp, SignedInUser } from './helpers/testApp';
import { addMember, createOwnedDevice } from './helpers/fixtures';

let db: TestDatabase;
let app: FastifyInstance;

const call = (user: SignedInUser, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, headers: user.headers, ...(payload ? { payload } : {}) });

async function roomOf(deviceId: string, accountId: string): Promise<string | null | undefined> {
    const result = await db.pool.query(
        'SELECT room_id FROM device_memberships WHERE device_id = $1 AND account_id = $2',
        [deviceId, accountId],
    );
    return result.rows[0]?.room_id;
}

test.describe('rooms', { skip: skipWithoutDatabase }, () => {
    test.before(async () => {
        db = await createTestDatabase();
        app = await buildTestApp(db.pool, [accountRoutes, sharingRoutes, roomRoutes]);
    });
    test.after(async () => {
        await app?.close();
        await db?.drop();
    });

    test('creates, renames, reorders and deletes rooms without touching devices', async () => {
        const owner = await signUp(app);
        const kitchen = await call(owner, 'POST', '/rooms', { name: '  Bếp   chính ', icon: 'kitchen' });
        assert.equal(kitchen.statusCode, 200, kitchen.body);
        assert.equal(kitchen.json().room.name, 'Bếp chính');
        const garden = (await call(owner, 'POST', '/rooms', { name: 'Sân vườn', icon: 'garden' })).json().room;
        const gate = (await call(owner, 'POST', '/rooms', { name: 'Cổng' })).json().room;
        assert.equal(gate.icon, 'home');

        const duplicate = await call(owner, 'POST', '/rooms', { name: 'bếp CHÍNH', icon: 'kitchen' });
        assert.equal(duplicate.statusCode, 409);
        assert.equal(duplicate.json().error.code, 'ROOM_NAME_TAKEN');
        assert.equal((await call(owner, 'POST', '/rooms', { name: 'X', icon: 'sofa' })).statusCode, 400);
        assert.equal((await call(owner, 'POST', '/rooms', { name: '   ', icon: 'home' })).statusCode, 400);

        const renamed = await call(owner, 'PATCH', `/rooms/${garden.id}`, { name: 'Vườn sau', icon: 'garden' });
        assert.equal(renamed.json().room.name, 'Vườn sau');
        assert.equal((await call(owner, 'PATCH', `/rooms/${garden.id}`, { name: 'Bếp chính' })).json().error.code, 'ROOM_NAME_TAKEN');

        const order = [gate.id, kitchen.json().room.id, garden.id];
        assert.equal((await call(owner, 'PUT', '/rooms/order', { room_ids: order })).statusCode, 200);
        const listed = (await call(owner, 'GET', '/rooms')).json();
        assert.deepEqual(listed.rooms.map((room: any) => room.id), order);
        assert.equal(listed.limits.max_rooms, 30);
        const partial = await call(owner, 'PUT', '/rooms/order', { room_ids: order.slice(1) });
        assert.equal(partial.json().error.code, 'ROOM_ORDER_MISMATCH');

        const device = await createOwnedDevice(db.pool, owner.id);
        assert.equal((await call(owner, 'PUT', `/devices/${device.mac}/room`, { room_id: gate.id })).statusCode, 200);
        assert.equal((await call(owner, 'GET', '/rooms')).json().rooms[0].device_count, 1);
        assert.equal((await call(owner, 'DELETE', `/rooms/${gate.id}`)).statusCode, 200);
        assert.equal(await roomOf(device.id, owner.id), null);
        const still = await db.pool.query('SELECT 1 FROM device_metadata WHERE id = $1', [device.id]);
        assert.equal(still.rowCount, 1);
        assert.equal((await call(owner, 'DELETE', `/rooms/${gate.id}`)).statusCode, 404);
    });

    test('each account arranges shared devices in its own rooms only', async () => {
        const owner = await signUp(app);
        const member = await signUp(app);
        const stranger = await signUp(app);
        const device = await createOwnedDevice(db.pool, owner.id, { productId: 'prod_entrance_controller' });
        await addMember(db.pool, device, owner.id, member.id);

        const ownerRoom = (await call(owner, 'POST', '/rooms', { name: 'Cổng chính', icon: 'entrance' })).json().room;
        const memberRoom = (await call(member, 'POST', '/rooms', { name: 'Nhà bố mẹ', icon: 'home' })).json().room;

        assert.equal((await call(owner, 'PUT', `/devices/${device.mac.toLowerCase()}/room`, { room_id: ownerRoom.id })).statusCode, 200);
        assert.equal((await call(member, 'PUT', `/devices/${device.mac}/room`, { room_id: memberRoom.id })).statusCode, 200);
        assert.equal(await roomOf(device.id, owner.id), ownerRoom.id);
        assert.equal(await roomOf(device.id, member.id), memberRoom.id);

        const foreignRoom = await call(member, 'PUT', `/devices/${device.mac}/room`, { room_id: ownerRoom.id });
        assert.equal(foreignRoom.statusCode, 404);
        assert.equal(foreignRoom.json().error.code, 'ROOM_NOT_FOUND');
        const foreignDevice = await call(stranger, 'PUT', `/devices/${device.mac}/room`, { room_id: null });
        assert.equal(foreignDevice.json().error.code, 'DEVICE_NOT_FOUND');
        assert.equal((await call(stranger, 'PATCH', `/rooms/${ownerRoom.id}`, { icon: 'garage' })).statusCode, 404);
        assert.equal((await call(stranger, 'DELETE', `/rooms/${ownerRoom.id}`)).statusCode, 404);

        // Leaving the device takes it out of the member's room; the room stays.
        assert.equal((await call(member, 'DELETE', `/devices/${device.mac}/membership`)).statusCode, 200);
        const memberRooms = (await call(member, 'GET', '/rooms')).json().rooms;
        assert.deepEqual(memberRooms.map((room: any) => [room.name, room.device_count]), [['Nhà bố mẹ', 0]]);
        assert.equal(await roomOf(device.id, owner.id), ownerRoom.id);

        assert.equal((await call(owner, 'PUT', `/devices/${device.mac}/room`, { room_id: null })).json().room_id, null);
    });

    test('setup applies a suggested layout in one step and reuses rooms by name', async () => {
        const owner = await signUp(app);
        const gate = await createOwnedDevice(db.pool, owner.id, { productId: 'prod_entrance_controller' });
        const camera = await createOwnedDevice(db.pool, owner.id, { productId: 'prod_security_camera' });
        const hazard = await createOwnedDevice(db.pool, owner.id, { productId: 'prod_hazard_mitigation' });
        const other = await signUp(app);
        const notMine = await createOwnedDevice(db.pool, other.id);
        await call(owner, 'POST', '/rooms', { name: 'Bếp', icon: 'kitchen' });

        const setup = await call(owner, 'POST', '/rooms/setup', {
            rooms: [
                { name: 'Cổng chính', icon: 'entrance', devices: [gate.mac, camera.mac.toLowerCase(), notMine.mac] },
                { name: 'bếp', icon: 'kitchen', devices: [hazard.mac] },
            ],
        });
        assert.equal(setup.statusCode, 200, setup.body);
        assert.deepEqual(
            setup.json().rooms.map((room: any) => [room.name, room.device_count]),
            [['Bếp', 1], ['Cổng chính', 2]],
        );
        assert.equal(await roomOf(notMine.id, other.id), null);
    });

    test('an account cannot exceed the room limit, even through setup', async () => {
        const owner = await signUp(app);
        await db.pool.query(
            `INSERT INTO rooms (account_id, name, position)
             SELECT $1, 'Phòng ' || n, n FROM generate_series(0, 29) AS n`,
            [owner.id],
        );
        const extra = await call(owner, 'POST', '/rooms', { name: 'Phòng thêm', icon: 'home' });
        assert.equal(extra.statusCode, 409);
        assert.equal(extra.json().error.code, 'ROOM_LIMIT_REACHED');
        const setup = await call(owner, 'POST', '/rooms/setup', { rooms: [{ name: 'Phòng 3', icon: 'home' }, { name: 'Mới', icon: 'home' }] });
        assert.equal(setup.json().error.code, 'ROOM_LIMIT_REACHED');
        const reused = await call(owner, 'POST', '/rooms/setup', { rooms: [{ name: 'phòng 3', icon: 'home' }] });
        assert.equal(reused.statusCode, 200, reused.body);
        assert.equal(reused.json().rooms.length, 30);
    });
});
