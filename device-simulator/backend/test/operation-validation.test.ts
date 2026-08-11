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
    removeCatalogConstants,
} from '../src/generation/telemetry-generator';
import {
    automaticRainClosePlan,
    beginRoofMotion,
    completeRoofMotion,
    pendingRoofMotionFromState,
    roofMotionPlanForOperation,
    SIMULATED_ROOF_MOTION_DURATION_MS,
} from '../src/runtime/roof-motion';

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

const openRoof: CapabilityOperation = {
    id: 'open',
    permission: 'cover.control',
    risk: 'normal',
    input: {},
    effects: [{ type: 'expect_reported', property: 'movement', value: 'opening' }],
};
const closeRoof: CapabilityOperation = {
    id: 'close',
    permission: 'cover.control',
    risk: 'normal',
    input: {},
    effects: [{ type: 'expect_reported', property: 'movement', value: 'closing' }],
};
const roofProduct: ProductCatalog = {
    schema: 'compiled.product.v2',
    product_id: 'prod_roof_test',
    catalog_revision: 2,
    model_name: 'Roof Test Product',
    category: 'environment',
    presentation: {},
    capability_instances: [{
        instance_id: 'roof_motor',
        capability_id: 'cover_controller',
        properties: [{
            id: 'movement',
            channel: 'reported',
            path: 'instances.roof_motor.reported.movement',
            type: 'string',
            enum: ['closed', 'opening', 'open', 'closing'],
            default: 'closed',
        }],
        operations: [openRoof, closeRoof],
    }],
    firmware_default_state: {
        schema: 'device.state.v2',
        state_version: 0,
        instances: { roof_motor: { reported: { movement: 'closed' }, desired: {} } },
        diagnostics: {},
    },
    operations: {
        'roof_motor.open': {
            ...openRoof,
            instance_id: 'roof_motor',
            capability_id: 'cover_controller',
        },
        'roof_motor.close': {
            ...closeRoof,
            instance_id: 'roof_motor',
            capability_id: 'cover_controller',
        },
    },
};

test('roof simulator models a fixed five-second four-state movement lifecycle', () => {
    const initial = generateInitialState(roofProduct);
    const plan = roofMotionPlanForOperation(roofProduct, {
        instance_id: 'roof_motor',
        operation_name: 'open',
    }, initial);
    assert.ok(plan);
    assert.equal(SIMULATED_ROOF_MOTION_DURATION_MS, 5_000);
    assert.equal(plan.movingState, 'opening');
    assert.equal(plan.finalState, 'open');
    assert.equal(plan.shouldMove, true);

    const moving = applyOperationToState(initial, roofProduct, {
        instance_id: 'roof_motor',
        operation_name: 'open',
        input: {},
    });
    assert.equal(moving.instances.roof_motor.reported.movement, 'opening');
    assert.deepEqual(pendingRoofMotionFromState(roofProduct, moving), plan);

    const completed = completeRoofMotion(moving, plan);
    assert.equal(completed.instances.roof_motor.reported.movement, 'open');
    assert.equal(completed.state_version, moving.state_version + 1);

    const repeated = roofMotionPlanForOperation(roofProduct, {
        instance_id: 'roof_motor',
        operation_name: 'open',
    }, completed);
    assert.equal(repeated?.shouldMove, false);
});

test('a reversed roof command makes the stale completion a no-op', () => {
    const initial = generateInitialState(roofProduct);
    const openPlan = roofMotionPlanForOperation(roofProduct, {
        instance_id: 'roof_motor',
        operation_name: 'open',
    }, initial);
    assert.ok(openPlan);
    const opening = applyOperationToState(initial, roofProduct, {
        instance_id: 'roof_motor',
        operation_name: 'open',
        input: {},
    });
    const closing = applyOperationToState(opening, roofProduct, {
        instance_id: 'roof_motor',
        operation_name: 'close',
        input: {},
    });

    assert.equal(completeRoofMotion(closing, openPlan), closing);
    const closePlan = roofMotionPlanForOperation(roofProduct, {
        instance_id: 'roof_motor',
        operation_name: 'close',
    }, opening);
    assert.ok(closePlan);
    assert.equal(completeRoofMotion(closing, closePlan).instances.roof_motor.reported.movement, 'closed');
});

test('restored snapshots drop properties removed from the Product contract', () => {
    const legacy = generateInitialState(roofProduct);
    legacy.instances.roof_motor.reported.max_run_seconds = 30;
    legacy.instances.roof_motor.reported.last_command_source = 'app';

    const sanitized = removeCatalogConstants(legacy, roofProduct);
    assert.deepEqual(sanitized.instances.roof_motor.reported, { movement: 'closed' });
});

test('automatic roof mode closes locally when the simulated rain sensor activates', () => {
    const automaticProduct: ProductCatalog = {
        ...roofProduct,
        capability_instances: [
            ...roofProduct.capability_instances,
            {
                instance_id: 'rain_sensor',
                capability_id: 'rain_detection',
                properties: [{
                    id: 'rain_detected',
                    channel: 'reported',
                    path: 'instances.rain_sensor.reported.rain_detected',
                    type: 'boolean',
                    default: false,
                }],
                operations: [],
            },
            {
                instance_id: 'roof_automation',
                capability_id: 'roof_policy',
                properties: [{
                    id: 'control_mode',
                    channel: 'reported',
                    path: 'instances.roof_automation.reported.control_mode',
                    type: 'string',
                    enum: ['manual', 'automatic'],
                    default: 'manual',
                }],
                operations: [],
            },
        ],
        firmware_default_state: {
            ...roofProduct.firmware_default_state,
            instances: {
                roof_motor: { reported: { movement: 'open' }, desired: {} },
                rain_sensor: { reported: { rain_detected: true }, desired: {} },
                roof_automation: { reported: { control_mode: 'automatic' }, desired: {} },
            },
        },
    };
    const state = generateInitialState(automaticProduct);
    const plan = automaticRainClosePlan(automaticProduct, state);

    assert.ok(plan);
    assert.equal(plan.movingState, 'closing');
    assert.equal(plan.finalState, 'closed');
    assert.equal(beginRoofMotion(state, plan).instances.roof_motor.reported.movement, 'closing');

    state.instances.roof_automation.reported.control_mode = 'manual';
    assert.equal(automaticRainClosePlan(automaticProduct, state), undefined);
});
