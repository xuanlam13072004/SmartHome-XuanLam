'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadCatalogV2 } = require('./catalog-v2');
const {
    CAPABILITY_CATEGORY,
    capabilityFilterFor,
    notificationCategory,
} = require('./notification-categories');

test('every capability that can raise a warning or critical event has a notification category', () => {
    const catalog = loadCatalogV2();
    const alerting = catalog.capabilities
        .filter(capability => (capability.events || []).some(event => ['warning', 'critical'].includes(event.severity)))
        .map(capability => capability.capability_id);
    assert.ok(alerting.length > 0);
    for (const capability of alerting) {
        assert.ok(CAPABILITY_CATEGORY[capability], `${capability} needs a category`);
    }
    assert.equal(notificationCategory('smoke_measurement'), 'safety');
    assert.equal(notificationCategory('unknown_capability'), 'device');
});

test('muting builds a capability filter; safety can never be muted', () => {
    assert.equal(capabilityFilterFor([]), null);
    assert.equal(capabilityFilterFor(['safety']), null);
    const noCamera = capabilityFilterFor(['camera']);
    assert.deepEqual(noCamera, { $nin: ['camera_stream', 'video_recording'] });
    const onlyListed = capabilityFilterFor(['device', 'outdoor']);
    assert.ok(onlyListed.$in.includes('smoke_measurement'));
    assert.ok(!onlyListed.$in.includes('rain_detection'));
});
