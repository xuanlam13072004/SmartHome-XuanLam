'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TelemetrySanitizer } = require('../src/services/telemetrySanitizer');

test('telemetry cannot overwrite Product Catalog constants', () => {
    const sanitizer = new TelemetrySanitizer({});
    const product = {
        capability_instances: [{
            instance_id: 'irrigation_automation',
            properties: [{
                id: 'target_moisture',
                channel: 'reported',
                state_authority: 'product_catalog',
                type: 'number',
                minimum: 10,
                maximum: 90,
                default: 50,
            }],
        }],
    };

    const result = sanitizer.sanitize({
        instances: {
            irrigation_automation: {
                reported: { target_moisture: 68.4 },
            },
        },
    }, product);

    assert.deepEqual(result.instances, {});
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0].type, 'authority');
    assert.match(result.warnings[0].error, /Product Catalog constants/);
});
