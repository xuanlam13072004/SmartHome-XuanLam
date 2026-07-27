import assert from 'node:assert/strict';
import test from 'node:test';
import {
    nextTelemetryDelayMs,
    startupDelayMs,
} from '../src/runtime/scheduling';

test('startupDelayMs spreads the first message across the configured ramp', () => {
    assert.equal(startupDelayMs(30_000, 5_000, 0), 0);
    assert.equal(startupDelayMs(30_000, 5_000, 0.5), 15_000);
    assert.equal(startupDelayMs(30_000, 5_000, 1), 30_000);
});

test('startupDelayMs falls back to one telemetry interval without a ramp', () => {
    assert.equal(startupDelayMs(0, 10_000, 0.25), 2_500);
});

test('nextTelemetryDelayMs applies bounded symmetric jitter', () => {
    assert.equal(nextTelemetryDelayMs(10_000, 20, 0), 8_000);
    assert.equal(nextTelemetryDelayMs(10_000, 20, 0.5), 10_000);
    assert.equal(nextTelemetryDelayMs(10_000, 20, 1), 12_000);
});

test('nextTelemetryDelayMs clamps jitter and keeps at least one second', () => {
    assert.equal(nextTelemetryDelayMs(1_000, 100, 0), 1_000);
    assert.equal(nextTelemetryDelayMs(500, 0, 0.5), 1_000);
});
