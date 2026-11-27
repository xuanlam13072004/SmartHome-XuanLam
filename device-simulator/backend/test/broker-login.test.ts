import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProductCatalog } from '../src/catalog/loader';
import { DeviceRuntime } from '../src/runtime/device-runtime';
import { RuntimeManager } from '../src/runtime/manager';
import { encrypt } from '../src/security/crypto';

const { compileCatalog, loadCatalogV2 } = require('../../../shared/catalog-v2');
const roof = compileCatalog(loadCatalogV2()).product_index.prod_roof_controller as ProductCatalog;
const logger = { child: () => logger, debug() {}, info() {}, warn() {}, error() {} } as any;
const MAC = 'AA:00:00:00:00:21';

const runtimeWith = (transport: Record<string, unknown>) => new DeviceRuntime(
    'run', MAC, roof, 30000, 0, 0, 0, logger,
    { isRelayAvailable: () => false, onBrokerUnavailable() {}, onBrokerAvailable() {}, ...transport } as any,
);

test('a refused login is not retried by the device: it is reported once and the device stays off', async () => {
    let attempts = 0;
    const runtime = runtimeWith({
        brokerCredentials: async () => ({ username: MAC, password: 'stored' }),
    });
    (runtime as any).openBrokerConnection = async () => {
        attempts += 1;
        throw Object.assign(new Error('Connection refused: Not authorized'), { code: 5 });
    };
    (runtime as any).updateRuntimeState = async () => undefined;
    await assert.rejects((runtime as any).ensureBrokerConnection(), /Not authorized/);
    assert.equal(attempts, 1);
    assert.equal(runtime.canConnect, true, 'the connect scheduler decides; the device does not loop');
    runtime.markLoginRefused();
    assert.equal(runtime.canConnect, false);
    assert.equal(runtime.liveRuntimeState, 'auth_rejected');
});

test('the broker login comes from the registry record; nothing is created on the fly', async () => {
    const records = new Map<string, any>([[MAC, { mac: MAC, mqtt_secret: encrypt('factory-made-password') }]]);
    let reads = 0;
    const db = { collection: () => ({
        findOne: async ({ mac }: any) => { reads += 1; return records.get(mac) || null; },
        updateOne: async () => { throw new Error('the login is never written by the runtime'); },
    }) };
    const scheduler = { submit() {}, forget() {}, setRefusedListener() {} };
    const manager = new RuntimeManager(logger, () => db as any, () => scheduler);
    assert.deepEqual(await manager.brokerCredentials('aa:00:00:00:00:21'), { username: MAC, password: 'factory-made-password' });
    assert.deepEqual(await manager.brokerCredentials(MAC), { username: MAC, password: 'factory-made-password' });
    assert.equal(reads, 1, 'kept in memory after the first read');
    await assert.rejects(manager.brokerCredentials('AA:00:00:00:00:99'), /has no MQTT login/);
});

test('devices are connected through the scheduler; a refusal it reports marks the device', async () => {
    const submitted: any[] = [];
    let refusedListener: ((mac: string, error: unknown) => void) | null = null;
    const forgotten: string[] = [];
    const scheduler = {
        submit: (target: any) => { submitted.push(target); },
        forget: (mac: string) => { forgotten.push(mac); },
        setRefusedListener: (listener: any) => { refusedListener = listener; },
    };
    const db = { collection: () => ({ findOne: async () => null, updateOne: async () => undefined }) };
    const manager = new RuntimeManager(logger, () => db as any, () => scheduler);
    (manager as any).start = RuntimeManager.prototype.start;
    await manager.start().catch(() => undefined); // the broker port check fails here; the listener is set first
    const device = manager.addDevice('run', MAC, roof, 30000, 0, 0, 0);
    (device as any).updateRuntimeState = async () => undefined;
    let connects = 0;
    (device as any).connect = async () => { connects += 1; };
    manager.scheduleConnect(device);
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0].mac, MAC);
    assert.equal(submitted[0].wantsConnection(), true);
    await submitted[0].connect();
    assert.equal(connects, 1);

    refusedListener!(MAC, Object.assign(new Error('Not authorized'), { code: 5 }));
    assert.equal(device.liveRuntimeState, 'auth_rejected');
    assert.equal(submitted[0].wantsConnection(), false, 'a refused device is not queued again');

    (device as any).dispose = async () => undefined;
    await manager.removeDevice(MAC);
    assert.deepEqual(forgotten, [MAC], 'removing a device drops its queued connection');
});
