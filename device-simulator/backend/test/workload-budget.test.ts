import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateWorkloadBudget } from '../src/workload/budget';

const limits = {
    maxUsersPerRun: 100,
    maxDevicesPerRun: 500,
    maxActiveDevices: 400,
    maxTelemetryMessagesPerSecond: 50,
};

test('workload budget accepts a workload inside every guardrail', () => {
    const result = evaluateWorkloadBudget({
        user_count: 10,
        devices_max: 5,
        initial_offline_rate: 20,
        telemetry_interval: 10,
        auto_start: true,
    }, limits);

    assert.equal(result.accepted, true);
    assert.deepEqual(result.estimate, {
        maximum_devices: 50,
        maximum_online_devices: 50,
        projected_telemetry_per_second: 5,
        expected_online_devices: 40,
        expected_telemetry_per_second: 4,
    });
    assert.deepEqual(result.violations, []);
});

test('workload budget reports all exceeded limits before starting a run', () => {
    const result = evaluateWorkloadBudget({
        user_count: 101,
        devices_max: 10,
        initial_offline_rate: 0,
        telemetry_interval: 5,
        auto_start: true,
    }, limits);

    assert.equal(result.accepted, false);
    assert.equal(result.violations.length, 4);
    assert.equal(result.estimate.maximum_devices, 1010);
    assert.equal(result.estimate.projected_telemetry_per_second, 202);
});

test('offline workloads do not consume active-device or telemetry budget', () => {
    const result = evaluateWorkloadBudget({
        user_count: 100,
        devices_max: 5,
        initial_offline_rate: 0,
        telemetry_interval: 5,
        auto_start: false,
    }, limits);

    assert.equal(result.accepted, true);
    assert.equal(result.estimate.maximum_online_devices, 0);
    assert.equal(result.estimate.projected_telemetry_per_second, 0);
});
