import './setup-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import {
    addConnection,
    applyAccessChange,
    closeSessions,
    recipientsOf,
    removeConnection,
} from '../src/services/connectionManager.js';
import { ACCOUNT_EVENT_NAME } from '../src/services/redisPubSub.js';

/** Minimal socket double: records sent events and close codes. */
function fakeSocket() {
    const socket = {
        readyState: WebSocket.OPEN as number,
        bufferedAmount: 0,
        events: [] as any[],
        closedWith: null as number | null,
        send(data: string) { socket.events.push(JSON.parse(data)); },
        close(code: number) { socket.closedWith = code; socket.readyState = WebSocket.CLOSED; },
        terminate() { socket.readyState = WebSocket.CLOSED; },
    };
    return socket;
}
const asWs = (socket: ReturnType<typeof fakeSocket>) => socket as unknown as WebSocket;

test('shared members receive live updates while they have access, and are told when it ends', () => {
    const mac = 'AA:00:00:00:00:01';
    const owner = fakeSocket();
    const member = fakeSocket();
    addConnection('owner-1', asWs(owner), 'session-owner');
    addConnection('member-1', asWs(member), 'session-member');

    assert.deepEqual(recipientsOf(mac, 'owner-1'), ['owner-1'], 'unknown device goes to the owner');

    applyAccessChange(mac, ['owner-1', 'member-1'], []);
    assert.deepEqual(recipientsOf(mac, 'owner-1').sort(), ['member-1', 'owner-1']);
    assert.deepEqual(member.events.at(-1), { event: 'device_access_granted', mac });

    applyAccessChange(mac, ['owner-1'], ['member-1']);
    assert.deepEqual(recipientsOf(mac, 'owner-1'), ['owner-1']);
    assert.deepEqual(member.events.at(-1), { event: 'device_access_revoked', mac });

    removeConnection('owner-1', asWs(owner));
    removeConnection('member-1', asWs(member));
});

test('an account that is not connected is not held in memory', () => {
    const mac = 'AA:00:00:00:00:02';
    applyAccessChange(mac, ['offline-owner', 'offline-member'], []);
    assert.deepEqual(recipientsOf(mac, 'offline-owner'), ['offline-owner']);
});

test('the last socket of an account leaving removes it from every audience', () => {
    const mac = 'AA:00:00:00:00:03';
    const socket = fakeSocket();
    addConnection('member-2', asWs(socket), 's');
    applyAccessChange(mac, ['owner-2', 'member-2'], []);
    assert.deepEqual(recipientsOf(mac, 'owner-2'), ['owner-2', 'member-2']);
    removeConnection('member-2', asWs(socket));
    assert.deepEqual(recipientsOf(mac, 'owner-2'), ['owner-2']);
});

test('signing out a session closes only that session\'s sockets', () => {
    const laptop = fakeSocket();
    const phone = fakeSocket();
    addConnection('user-3', asWs(laptop), 'laptop-session');
    addConnection('user-3', asWs(phone), 'phone-session');

    assert.equal(closeSessions('user-3', ['unknown-session']), 0);
    assert.equal(closeSessions('user-3', ['laptop-session']), 1);
    assert.equal(laptop.closedWith, 4003);
    assert.deepEqual(laptop.events.at(-1), { event: 'session_revoked', message: 'Signed out' });
    assert.equal(phone.closedWith, null);

    assert.equal(closeSessions('user-3', 'all'), 1);
    assert.equal(phone.closedWith, 4003);
});

test('only known personal event families are forwarded to an account', () => {
    for (const name of ['sharing_invite_received', 'notification_created', 'scene_run_updated', 'automation_fired', 'payment_updated', 'plan_expiring']) {
        assert.ok(ACCOUNT_EVENT_NAME.test(name), name);
    }
    for (const name of ['device_status', 'session_revoked', 'scene_', 'Scene_run', 'scene_run_updated;x']) {
        assert.ok(!ACCOUNT_EVENT_NAME.test(name), name);
    }
});
