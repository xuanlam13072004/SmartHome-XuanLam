import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProductCatalog } from '../src/catalog/loader';
import {
    applyOperationToState,
    evolveState,
    generateInitialState,
    patchDeviceState,
} from '../src/generation/telemetry-generator';

const product: ProductCatalog = {
    schema: 'compiled.product.v2',
    product_id: 'prod_state_patch',
    catalog_revision: 1,
    model_name: 'State Patch Product',
    category: 'sensor',
    presentation: {},
    capability_instances: [{
        capability_id: 'environment',
        instance_id: 'main',
        properties: [
            { id: 'temperature', channel: 'reported', path: 'instances.main.reported.temperature', type: 'number', minimum: -20, maximum: 80 },
            { id: 'fixed_threshold', channel: 'reported', state_authority: 'product_catalog', path: 'instances.main.reported.fixed_threshold', type: 'number', default: 50 },
            { id: 'mode', channel: 'desired', path: 'instances.main.desired.mode', type: 'string', enum: ['eco', 'comfort'] },
            { id: 'online', channel: 'diagnostic', path: 'diagnostics.main.online', type: 'boolean' },
            { id: 'firmware_status', channel: 'diagnostic', path: 'diagnostics.main.firmware_status', type: 'string', enum: ['unknown', 'healthy', 'fault'], default: 'unknown' },
        ],
        operations: [],
    }],
    firmware_default_state: {
        schema: 'device.state.v2',
        state_version: 0,
        instances: { main: { reported: { temperature: 25, fixed_threshold: 68.4 }, desired: { mode: 'eco' } } },
        diagnostics: { main: { online: true } },
    },
    operations: {},
};

const current = {
    state_version: 4,
    instances: { main: { reported: { temperature: 25, fixed_threshold: 68.4 }, desired: { mode: 'eco' } } },
    diagnostics: { main: { online: true, firmware_status: 'healthy' } },
};

test('automatic evolution changes explicit measurements but not arbitrary physical numbers', () => {
    const originalRandom = Math.random;
    Math.random = () => 1;
    try {
        const evolved = evolveState(current, product);
        assert.equal(evolved.instances.main.reported.temperature, 26);
    } finally {
        Math.random = originalRandom;
    }
});

const doorProduct: ProductCatalog = {
    schema: 'compiled.product.v2',
    product_id: 'prod_entrance_controller',
    catalog_revision: 3,
    model_name: 'Entrance Controller',
    category: 'security',
    presentation: {},
    capability_instances: [
        {
            capability_id: 'door_lock',
            instance_id: 'main_lock',
            properties: [{
                id: 'lock_state',
                channel: 'reported',
                state_authority: 'device_firmware',
                path: 'instances.main_lock.reported.lock_state',
                type: 'string',
                enum: ['locked', 'unlocked'],
                default: 'locked',
            }],
            operations: [
                {
                    id: 'lock',
                    permission: 'door.control',
                    risk: 'normal',
                    input: {},
                    effects: [{ type: 'expect_reported', property: 'lock_state', value: 'locked' }],
                },
                {
                    id: 'unlock',
                    permission: 'door.control',
                    risk: 'sensitive',
                    input: {},
                    effects: [{ type: 'expect_reported', property: 'lock_state', value: 'unlocked' }],
                },
            ],
        },
        {
            capability_id: 'character_display_4x20',
            instance_id: 'lcd',
            properties: [
                {
                    id: 'displayed_lines',
                    channel: 'reported',
                    state_authority: 'device_firmware',
                    path: 'instances.lcd.reported.displayed_lines',
                    type: 'array',
                    min_items: 4,
                    max_items: 4,
                    items: { type: 'string', max_length: 20 },
                    default: ['', '', '', ''],
                },
                {
                    id: 'display_source',
                    channel: 'reported',
                    state_authority: 'device_firmware',
                    path: 'instances.lcd.reported.display_source',
                    type: 'string',
                    enum: ['firmware', 'authentication', 'safety', 'custom'],
                    default: 'firmware',
                },
            ],
            operations: [],
        },
    ],
    firmware_default_state: {
        schema: 'device.state.v2',
        state_version: 0,
        instances: {
            main_lock: { reported: { lock_state: 'locked' }, desired: {} },
            lcd: {
                reported: { displayed_lines: ['', '', '', ''], display_source: 'firmware' },
                desired: {},
            },
        },
        diagnostics: {},
    },
    operations: {
        'main_lock.lock': {
            id: 'lock',
            instance_id: 'main_lock',
            capability_id: 'door_lock',
            permission: 'door.control',
            risk: 'normal',
            input: {},
            effects: [{ type: 'expect_reported', property: 'lock_state', value: 'locked' }],
        },
        'main_lock.unlock': {
            id: 'unlock',
            instance_id: 'main_lock',
            capability_id: 'door_lock',
            permission: 'door.control',
            risk: 'sensitive',
            input: {},
            effects: [{ type: 'expect_reported', property: 'lock_state', value: 'unlocked' }],
        },
        'lcd.set_custom_message': {
            id: 'set_custom_message',
            instance_id: 'lcd',
            capability_id: 'character_display_4x20',
            permission: 'display.write',
            risk: 'normal',
            input: {
                lines: {
                    type: 'array',
                    min_items: 4,
                    max_items: 4,
                    items: { type: 'string', max_length: 20 },
                },
            },
            effects: [
                { type: 'expect_reported', property: 'displayed_lines', value_from: 'input.lines' },
                { type: 'expect_reported', property: 'display_source', value: 'custom' },
            ],
        },
        'lcd.clear_custom_message': {
            id: 'clear_custom_message',
            instance_id: 'lcd',
            capability_id: 'character_display_4x20',
            permission: 'display.write',
            risk: 'normal',
            input: {},
            effects: [{ type: 'expect_reported', property: 'display_source', value: 'firmware' }],
        },
    },
};

test('new entrance devices start locked and store only stable servo-derived state', () => {
    const initial = generateInitialState(doorProduct);
    assert.deepEqual(initial.instances.main_lock, {
        reported: { lock_state: 'locked' },
        desired: {},
    });

    const unlocked = applyOperationToState(initial, doorProduct, {
        instance_id: 'main_lock',
        operation_name: 'unlock',
        input: {},
    });
    assert.equal(unlocked.instances.main_lock.reported.lock_state, 'unlocked');
    assert.deepEqual(unlocked.instances.main_lock.desired, {});

    const locked = applyOperationToState(unlocked, doorProduct, {
        instance_id: 'main_lock',
        operation_name: 'lock',
        input: {},
    });
    assert.equal(locked.instances.main_lock.reported.lock_state, 'locked');
    assert.deepEqual(locked.instances.main_lock.desired, {});
});

test('entrance LCD accepts exactly four persistent custom lines until firmware resumes', () => {
    const initial = generateInitialState(doorProduct);
    const lines = ['Nha cua Xuan Lam', 'Xin chao ban', 'Cua dang khoa', 'Hen gap lai'];
    const custom = applyOperationToState(initial, doorProduct, {
        instance_id: 'lcd',
        operation_name: 'set_custom_message',
        input: { lines },
    });

    assert.deepEqual(custom.instances.lcd.reported.displayed_lines, lines);
    assert.equal(custom.instances.lcd.reported.display_source, 'custom');

    const restored = applyOperationToState(custom, doorProduct, {
        instance_id: 'lcd',
        operation_name: 'clear_custom_message',
        input: {},
    });
    assert.equal(restored.instances.lcd.reported.display_source, 'firmware');
});

test('manual state patch merges catalog-valid nested state and advances its version', () => {
    const next = patchDeviceState(current, product, {
        instances: { main: { reported: { temperature: 31 } } },
        diagnostics: { main: { online: false, firmware_status: 'fault' } },
    });
    assert.equal(next.instances.main.reported.temperature, 31);
    assert.equal(next.instances.main.reported.fixed_threshold, undefined);
    assert.equal(next.instances.main.desired.mode, 'eco');
    assert.equal(next.diagnostics.main.online, false);
    assert.equal(next.diagnostics.main.firmware_status, 'fault');
    assert.equal(next.state_version, 5);
});

test('manual state patch rejects unknown, out-of-range and wrong-channel properties', () => {
    assert.throws(
        () => patchDeviceState(current, product, { instances: { main: { reported: { unknown: 1 } } } }),
        /Unknown reported property/,
    );
    assert.throws(
        () => patchDeviceState(current, product, { instances: { main: { reported: { temperature: 100 } } } }),
        /at most 80/,
    );
    assert.throws(
        () => patchDeviceState(current, product, { instances: { main: { reported: { mode: 'eco' } } } }),
        /Unknown reported property/,
    );
    assert.throws(
        () => patchDeviceState(current, product, { instances: { main: { reported: { fixed_threshold: 55 } } } }),
        /Product Catalog constant .* cannot be patched/,
    );
});

test('Product Catalog constants are absent from generated and evolved device state', () => {
    const initial = generateInitialState(product);
    assert.equal(initial.instances.main.reported.fixed_threshold, undefined);
    assert.equal(initial.diagnostics.main.firmware_status, 'unknown');

    const evolved = evolveState(current, product);
    assert.equal(evolved.instances.main.reported.fixed_threshold, undefined);
});
