import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProductCatalog } from '../src/catalog/loader';
import {
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
    diagnostics: { main: { online: true } },
};

test('manual state patch merges catalog-valid nested state and advances its version', () => {
    const next = patchDeviceState(current, product, {
        instances: { main: { reported: { temperature: 31 } } },
        diagnostics: { main: { online: false } },
    });
    assert.equal(next.instances.main.reported.temperature, 31);
    assert.equal(next.instances.main.reported.fixed_threshold, undefined);
    assert.equal(next.instances.main.desired.mode, 'eco');
    assert.equal(next.diagnostics.main.online, false);
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

    const evolved = evolveState(current, product);
    assert.equal(evolved.instances.main.reported.fixed_threshold, undefined);
});
