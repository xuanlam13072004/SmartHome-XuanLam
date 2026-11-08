import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProductCatalog } from '../src/catalog/loader';
import {
    buildPairingPayload,
    encodePairingPayload,
    FACTORY_RUN_ID,
    factoryRunContext,
    formatBatchId,
    formatSerialNumber,
    productSerialCode,
} from '../src/factory/pairing';
import { DeviceRuntime } from '../src/runtime/device-runtime';
import { RuntimeManager } from '../src/runtime/manager';
import { parseTopologyAssignment } from '../src/runtime/topology';

const { compileCatalog, loadCatalogV2 } = require('../../../shared/catalog-v2');
const roof = compileCatalog(loadCatalogV2()).product_index.prod_roof_controller as ProductCatalog;

const logger = {
    child: () => logger,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
} as any;

const mac = 'AA:00:00:00:00:0F';
const claimAssignment = parseTopologyAssignment({
    schema: 'device.topology.assignment.v2',
    network_id: 'network-claimed',
    topology_epoch: 1,
    topology_state: 'stable',
    role: 'hub',
    join_rank: 1,
    active_hub_mac: mac,
    transport_mode: 'hub',
    members: [{ device_id: 'device-uuid-1', mac, join_rank: 1, role: 'hub' }],
});

test('the QR label carries exactly what the app needs to claim a device', () => {
    const payload = encodePairingPayload(buildPairingPayload(' aa:bb:cc:dd:ee:ff ', 'f'.repeat(48)));
    // Same shape DeviceQrPayload.parse accepts in the Flutter app.
    assert.deepEqual(JSON.parse(payload), {
        type: 'smarthome-device',
        version: 1,
        mac: 'AA:BB:CC:DD:EE:FF',
        secret_key: 'f'.repeat(48),
    });
    assert.ok(payload.length < 130, 'compact payload keeps the QR symbol small');
});

test('serial numbers and lot ids encode product, production date and sequence', () => {
    const date = new Date('2026-11-07T10:00:00Z');
    assert.equal(formatSerialNumber('prod_security_camera', date, 7), 'SX-CAM-2611-0007');
    assert.equal(formatSerialNumber('prod_entrance_controller', date, 12345), 'SX-ENT-2611-12345');
    assert.equal(formatBatchId(date, 3), 'LOT-261107-003');
    assert.equal(productSerialCode('prod_water_heater'), 'WAT');
    assert.equal(productSerialCode('prod_x'), 'XXX');
});

test('factory devices run with fixed settings outside every simulation run', () => {
    const run = factoryRunContext();
    assert.equal(run.id, FACTORY_RUN_ID);
    assert.ok(run.config.telemetry_interval >= 5);
});

test('a blank device holds its broker session in pairing mode and publishes nothing until claimed', async (t) => {
    const transport = {
        isRelayAvailable: () => false,
        onBrokerUnavailable() {},
        onBrokerAvailable() {},
    } as any;
    const runtime = new DeviceRuntime(
        FACTORY_RUN_ID, mac, roof, 30000, 0, 0, 0, logger, transport,
        undefined, undefined, undefined, undefined, { awaitClaim: true },
    );
    const states: string[] = [];
    const published: string[] = [];
    let telemetryStarted = 0;
    let brokerSessions = 0;
    Object.assign(runtime as any, {
        ensureBrokerConnection: async () => {
            brokerSessions += 1;
            (runtime as any).mqttClient = { connected: true, end: (_force: boolean, _opts: unknown, done: () => void) => done() };
        },
        refreshSubscriptions: async () => undefined,
        updateRuntimeState: async (state: string) => { states.push(state); },
        persistRegistryState: async () => undefined,
        startTelemetry: () => { telemetryStarted += 1; },
        stopTelemetry: () => undefined,
        startPresenceHeartbeat: () => undefined,
        stopPresenceHeartbeat: () => undefined,
        publishPresence: async (kind: string) => { published.push(kind); },
        flushPendingDeviceEvents: async () => undefined,
        publishTopologyReadyAck: async () => undefined,
        reserveNextSequence: async () => { throw new Error('an unclaimed device must not emit events'); },
    });
    t.after(() => runtime.dispose().catch(() => undefined));

    await runtime.connect();
    assert.equal(brokerSessions, 1);
    assert.equal(runtime.awaitingClaim, true);
    assert.equal(runtime.connected, false);
    assert.deepEqual(states, ['awaiting_claim']);
    assert.equal(telemetryStarted, 0);
    assert.deepEqual(published, []);
    await (runtime as any).emitDeviceEvent({ instance_id: 'roof', event_name: 'test', data: {} });

    // The claim assignment arrives on the device's own topology topic.
    (runtime as any).assignment = claimAssignment;
    await (runtime as any).reconcileTransport();
    assert.equal(runtime.awaitingClaim, false);
    assert.equal(runtime.connected, true);
    assert.equal(states.at(-1), 'online');
    assert.equal(telemetryStarted, 1);
    assert.deepEqual(published, ['online']);
});

test('the first assignment of a device in pairing mode records the claim', async () => {
    const writes: any[] = [];
    const db = {
        collection: () => ({
            updateOne: async (...args: any[]) => {
                writes.push(args);
                return { modifiedCount: 1 };
            },
        }),
    };
    const manager = new RuntimeManager(logger, () => db as any);
    const claims: Array<[string, string | null]> = [];
    manager.setFactoryLifecycleListener({
        onClaimed: (claimedMac, deviceId) => { claims.push([claimedMac, deviceId]); },
        onReleased: async () => undefined,
    });
    let applied = 0;
    (manager as any).devices.set(mac, {
        runId: FACTORY_RUN_ID,
        awaitingClaim: true,
        applyTopologyAssignment: async () => { applied += 1; },
        refreshTransportAvailability: async () => undefined,
        topology: undefined,
    });

    await manager.onTopologyMessage(mac, Buffer.from(JSON.stringify(claimAssignment)));
    const claim = writes.find(([filter]) => filter.origin === 'factory');
    assert.ok(claim, 'claim written for factory devices only');
    assert.deepEqual(claim[0].provisioning_state, { $ne: 'claimed' });
    assert.equal(claim[1].$set.provisioning_state, 'claimed');
    assert.equal(claim[1].$set.device_id, 'device-uuid-1');
    assert.deepEqual(claims, [[mac, 'device-uuid-1']]);
    assert.equal(applied, 1);

    // A newer assignment of the same owner is a topology change, not a new claim.
    writes.length = 0;
    await manager.onTopologyMessage(mac, Buffer.from(JSON.stringify({ ...claimAssignment, topology_epoch: 2 })));
    assert.equal(writes.some(([filter]) => filter.origin === 'factory'), false);
});

test('an unpaired factory device is reset to the shelf instead of being retired', async () => {
    const writes: any[] = [];
    const db = {
        collection: () => ({
            findOne: async () => ({ run_id: FACTORY_RUN_ID, origin: 'factory' }),
            updateOne: async (...args: any[]) => { writes.push(args); },
        }),
    };
    const manager = new RuntimeManager(logger, () => db as any);
    let disposed = false;
    const released = new Promise<string>((resolve) => {
        manager.setFactoryLifecycleListener({
            onClaimed: () => undefined,
            onReleased: async (releasedMac) => resolve(releasedMac),
        });
    });
    (manager as any).devices.set(mac, { runId: FACTORY_RUN_ID, dispose: async () => { disposed = true; } });
    (manager as any).assignments.set(mac, claimAssignment);

    await manager.onTopologyMessage(mac, Buffer.alloc(0));
    assert.equal(disposed, true);
    const reset = writes.at(-1);
    assert.equal(reset[1].$set.provisioning_state, 'provisioned');
    assert.equal('desired_state' in reset[1].$set, false, 'power switch stays as it was');
    assert.ok('device_id' in reset[1].$unset);
    assert.ok('claimed_at' in reset[1].$unset);
    assert.ok('state_snapshot' in reset[1].$unset);
    assert.equal(await released, mac);
});
