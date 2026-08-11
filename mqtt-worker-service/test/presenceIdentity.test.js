'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    assertPresenceProductIdentity,
} = require('../src/workers/telemetrySubscriber');

const context = {
    productId: 'prod_roof_controller',
    catalogRevision: 2,
};

test('presence accepts a Product identity matching the claimed device', () => {
    assert.doesNotThrow(() => assertPresenceProductIdentity({
        product_id: 'prod_roof_controller',
        catalog_revision: 2,
    }, context));
});

test('presence rejects a stale or newer Product identity', () => {
    assert.throws(
        () => assertPresenceProductIdentity({
            product_id: 'prod_roof_controller',
            catalog_revision: 1,
        }, context),
        /Presence Product identity does not match/,
    );
});

test('presence remains backward compatible with legacy physical firmware', () => {
    assert.doesNotThrow(() => assertPresenceProductIdentity({}, context));
});
