import assert from 'node:assert/strict';
import test from 'node:test';
import {
    BrokerIdentityRegistry,
    DEVICE_ROLE,
    type DynsecCommand,
    type DynsecResponse,
} from '../src/infrastructure/mqtt/broker-identity';

const fakeBroker = (existing = new Set<string>()) => {
    const messages: DynsecCommand[][] = [];
    const passwords = new Map<string, string>();
    const transport = async (commands: DynsecCommand[]): Promise<DynsecResponse[]> => {
        messages.push(commands);
        return commands.map((command) => {
            const username = String(command.username);
            if (command.command === 'createClient') {
                if (existing.has(username)) return { command: command.command, error: 'Client already exists' };
                existing.add(username);
                passwords.set(username, String(command.password));
                return { command: command.command };
            }
            if (command.command === 'modifyClient') {
                passwords.set(username, String(command.password));
                return { command: command.command };
            }
            if (command.command === 'deleteClient') {
                if (!existing.delete(username)) return { command: command.command, error: 'Client not found' };
                return { command: command.command };
            }
            return { command: command.command, error: 'Unknown command' };
        });
    };
    return { transport, messages, passwords, existing };
};

test('registrations inside one batch window share one control message', async () => {
    const broker = fakeBroker();
    const registry = new BrokerIdentityRegistry(broker.transport, 20);
    await Promise.all([
        registry.ensureDeviceIdentity('aa:00:00:00:00:01', 'p1'),
        registry.ensureDeviceIdentity('AA:00:00:00:00:02', 'p2'),
    ]);
    assert.equal(broker.messages.length, 1);
    assert.deepEqual(broker.messages[0].map(command => command.username), ['AA:00:00:00:00:01', 'AA:00:00:00:00:02']);
    assert.deepEqual(broker.messages[0][0].roles, [{ rolename: DEVICE_ROLE, priority: 0 }]);
});

test('an existing identity is re-keyed instead of failing', async () => {
    const broker = fakeBroker(new Set(['AA:00:00:00:00:01']));
    const registry = new BrokerIdentityRegistry(broker.transport, 0);
    await registry.ensureDeviceIdentity('AA:00:00:00:00:01', 'new-password');
    assert.equal(broker.passwords.get('AA:00:00:00:00:01'), 'new-password');
    assert.equal(broker.messages[1][0].command, 'modifyClient');
});

test('revoking is idempotent and broker errors reject only the affected request', async () => {
    const broker = fakeBroker(new Set(['AA:00:00:00:00:01']));
    const registry = new BrokerIdentityRegistry(async (commands) => {
        const responses = await broker.transport(commands);
        return responses.map((response, index) => (
            commands[index].username === 'AA:00:00:00:00:09' ? { ...response, error: 'Role not found' } : response
        ));
    }, 10);
    const results = await Promise.allSettled([
        registry.revokeDeviceIdentity('AA:00:00:00:00:01'),
        registry.revokeDeviceIdentity('AA:00:00:00:00:01'),
        registry.ensureDeviceIdentity('AA:00:00:00:00:09', 'x'),
    ]);
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].status, 'fulfilled');
    assert.equal(results[2].status, 'rejected');
    assert.equal(broker.existing.has('AA:00:00:00:00:01'), false);
});
