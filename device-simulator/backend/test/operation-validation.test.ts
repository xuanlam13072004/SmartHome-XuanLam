import assert from 'node:assert/strict';
import test from 'node:test';
import type { CapabilityOperation, ProductCatalog } from '../src/catalog/loader';
import {
    parseDeviceOperation,
    validateOperationInput,
} from '../src/generation/operation-validation';
import {
    applyOperationToState,
    generateInitialState,
} from '../src/generation/telemetry-generator';

const setLevel: CapabilityOperation = {
    id: 'set_level',
    permission: 'device.control',
    risk: 'normal',
    input: {
        level: { type: 'number', minimum: 0, maximum: 100 },
    },
    effects: [{ type: 'expect_reported', property: 'level', value_from: 'input.level' }],
};

const product: ProductCatalog = {
    schema: 'compiled.product.v2',
    product_id: 'prod_test',
    catalog_revision: 2,
    model_name: 'Test Product',
    category: 'test',
    presentation: {},
    capability_instances: [{
        instance_id: 'main',
        capability_id: 'level_control',
        properties: [{
            id: 'level',
            channel: 'reported',
            path: 'instances.main.reported.level',
            type: 'number',
            minimum: 0,
            maximum: 100,
            default: 10,
        }],
        operations: [setLevel],
    }],
    firmware_default_state: {
        schema: 'device.state.v2',
        state_version: 0,
        instances: { main: { reported: { level: 10 }, desired: {} } },
        diagnostics: {},
    },
    operations: {
        'main.set_level': { ...setLevel, instance_id: 'main', capability_id: 'level_control' },
    },
};

const validOperation = {
    schema: 'device.operation.v2',
    operation_id: '995ee62b-25c6-4656-b198-0ea4407712cf',
    target_device_id: 'aa:00:00:00:00:02',
    product_id: 'prod_test',
    catalog_revision: 2,
    instance_id: 'main',
    operation_name: 'set_level',
    input: { level: 75 },
    issued_at: new Date().toISOString(),
    timeout_at: new Date(Date.now() + 60_000).toISOString(),
    route: {
        mode: 'relay',
        network_id: 'network-a',
        topology_epoch: 4,
        hub_mac: 'aa:00:00:00:00:01',
    },
} as const;

test('operation parser enforces the V2 envelope and normalizes MAC addresses', () => {
    const parsed = parseDeviceOperation(validOperation);
    assert.equal(parsed.target_device_id, 'AA:00:00:00:00:02');
    assert.equal(parsed.route.hub_mac, 'AA:00:00:00:00:01');
    assert.throws(
        () => parseDeviceOperation({ ...validOperation, schema: 'invalid.operation' }),
        /contract is invalid/,
    );
});

test('operation input rejects missing, unknown and out-of-range fields', () => {
    assert.doesNotThrow(() => validateOperationInput(setLevel, { level: 50 }));
    assert.throws(() => validateOperationInput(setLevel, {}), /Missing operation input level/);
    assert.throws(
        () => validateOperationInput(setLevel, { level: 50, extra: true }),
        /Unexpected operation input/,
    );
    assert.throws(() => validateOperationInput(setLevel, { level: 101 }), /at most 100/);
});

test('applied operations mutate only contract-defined state and advance state version', () => {
    const current = generateInitialState(product);
    const next = applyOperationToState(current, product, {
        instance_id: 'main',
        operation_name: 'set_level',
        input: { level: 75 },
    });
    assert.equal(next.instances.main.reported.level, 75);
    assert.equal(next.state_version, 1);
    assert.equal(current.instances.main.reported.level, 10);
});
