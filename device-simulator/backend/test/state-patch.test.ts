import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProductCatalog } from '../src/catalog/loader';
import { patchDeviceState } from '../src/generation/telemetry-generator';

const product: ProductCatalog = {
    id: 'state-patch-product',
    display_name: 'State patch product',
    category: 'sensor',
    capabilities: [],
    default_state: {},
    capabilityInstances: [{
        capability_id: 'environment',
        instance: 'main',
        state_properties: {
            temperature: { value_type: 'number', validation: { min: -20, max: 80 } },
            mode: { value_type: 'string', validation: { enum: ['eco', 'comfort'] } },
        },
        diagnostic_properties: {
            online: { value_type: 'boolean' },
        },
        commands: [],
    }],
};

test('manual state patch merges catalog-valid metrics and diagnostics', () => {
    const next = patchDeviceState(
        {
            metrics: { temperature: 25, mode: 'eco' },
            diagnostics: { online: true },
        },
        product,
        {
            metrics: { temperature: 31 },
            diagnostics: { online: false },
        },
    );
    assert.deepEqual(next, {
        metrics: { temperature: 31, mode: 'eco' },
        diagnostics: { online: false },
    });
});

test('manual state patch rejects unknown, out-of-range and invalid enum values', () => {
    const current = {
        metrics: { temperature: 25, mode: 'eco' },
        diagnostics: { online: true },
    };
    assert.throws(
        () => patchDeviceState(current, product, { metrics: { unknown: 1 } }),
        /Unknown metrics state key unknown/,
    );
    assert.throws(
        () => patchDeviceState(current, product, { metrics: { temperature: 100 } }),
        /at most 80/,
    );
    assert.throws(
        () => patchDeviceState(current, product, { metrics: { mode: 'turbo' } }),
        /allowed enum/,
    );
});
