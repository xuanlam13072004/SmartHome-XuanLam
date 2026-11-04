'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BACKEND_ROLE, DEVICE_ROLE, ROLE_ACLS, ensureClient } = require('../src/tools/dynsecClient');
const { initializeBroker } = require('../src/tools/initializeBroker');

/** In-memory stand-in for the Dynamic Security command API. */
function fakeDynsec() {
    const roles = new Map();
    const clients = new Map();
    let defaults = null;
    const handle = (command) => {
        switch (command.command) {
            case 'createRole':
                if (roles.has(command.rolename)) return { error: 'Role already exists' };
                roles.set(command.rolename, []);
                return {};
            case 'addRoleACL': {
                const acls = roles.get(command.rolename);
                if (acls.some(acl => acl.acltype === command.acltype && acl.topic === command.topic)) {
                    return { error: 'ACL with this topic already exists' };
                }
                acls.push({ acltype: command.acltype, topic: command.topic, allow: command.allow });
                return {};
            }
            case 'setDefaultACLAccess':
                defaults = command.acls;
                return {};
            case 'createClient':
                if (clients.has(command.username)) return { error: 'Client already exists' };
                clients.set(command.username, { password: command.password, roles: command.roles });
                return {};
            case 'modifyClient':
                if (!clients.has(command.username)) return { error: 'Client not found' };
                clients.set(command.username, { password: command.password, roles: command.roles });
                return {};
            default:
                return { error: 'Unknown command' };
        }
    };
    return {
        roles,
        clients,
        defaults: () => defaults,
        send: async commands => commands.map(command => ({ command: command.command, ...handle(command) })),
    };
}

const settings = {
    workerUsername: 'mqtt-worker-service',
    workerPassword: 'worker-secret-0001',
    factoryUsername: 'device-factory',
    factoryPassword: 'factory-secret-0001',
};

test('device role only reaches its own topics and cannot write downlink topics', () => {
    const acls = ROLE_ACLS[DEVICE_ROLE];
    assert.ok(acls.every(acl => acl.topic.startsWith('smarthome/%u/')));
    const published = acls.filter(acl => acl.acltype === 'publishClientSend').map(acl => acl.topic);
    for (const downlink of ['control', 'hub/control', 'topology']) {
        assert.ok(!published.includes(`smarthome/%u/${downlink}`), `device must not publish ${downlink}`);
    }
});

test('broker initialization is idempotent and re-keys service identities', async () => {
    const dynsec = fakeDynsec();
    assert.deepEqual(await initializeBroker(dynsec, settings), { worker: 'created', factory: 'created' });
    assert.deepEqual(await initializeBroker(dynsec, { ...settings, workerPassword: 'rotated-secret-0002' }), {
        worker: 'updated',
        factory: 'updated',
    });
    assert.equal(dynsec.roles.get(DEVICE_ROLE).length, ROLE_ACLS[DEVICE_ROLE].length);
    assert.equal(dynsec.clients.get('mqtt-worker-service').password, 'rotated-secret-0002');
    assert.deepEqual(dynsec.clients.get('mqtt-worker-service').roles, [{ rolename: BACKEND_ROLE, priority: 0 }]);
    assert.deepEqual(dynsec.clients.get('device-factory').roles, [{ rolename: 'dynsec-admin', priority: 0 }]);
    assert.ok(dynsec.defaults().every(acl => acl.allow === false));
});

test('ensureClient surfaces unexpected broker errors', async () => {
    const dynsec = { send: async () => [{ command: 'createClient', error: 'Role not found' }] };
    await assert.rejects(
        ensureClient(dynsec, { username: 'AA:BB:CC:DD:EE:FF', password: 'x', roles: [DEVICE_ROLE] }),
        /Role not found/,
    );
});
