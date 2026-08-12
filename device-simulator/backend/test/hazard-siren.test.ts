import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProductCatalog } from '../src/catalog/loader';
import type { DeviceOperation } from '../src/generation/operation-validation';
import type { DeviceState } from '../src/generation/telemetry-generator';
import {
    assertSirenOperationAllowed,
    beginSirenTimer,
    completeSirenTimer,
    pendingSirenTimerFromState,
    reconcileHazardSafetyState,
    sirenTimerPlanForPhysicalAction,
    sirenTimerPlanForOperation,
} from '../src/runtime/hazard-siren';

const product = {
    product_id: 'prod_hazard_mitigation',
    capability_instances: [
        {
            instance_id: 'alarm_siren',
            capability_id: 'alarm_siren',
            properties: [
                {
                    id: 'audible_state',
                    channel: 'reported',
                    enum: ['silent', 'sounding', 'muted'],
                },
                { id: 'mute_until', channel: 'reported', type: 'string' },
            ],
        },
        { instance_id: 'hazard', capability_id: 'hazard_controller', properties: [] },
        { instance_id: 'gas', capability_id: 'gas_measurement', properties: [] },
        { instance_id: 'smoke', capability_id: 'smoke_measurement', properties: [] },
        { instance_id: 'flame', capability_id: 'flame_detection', properties: [] },
    ],
    operations: {
        'alarm_siren.mute_siren': { capability_id: 'alarm_siren' },
        'alarm_siren.test_siren': { capability_id: 'alarm_siren' },
    },
} as unknown as ProductCatalog;

const state = (audibleState: string, riskLevel = 'normal'): DeviceState => ({
    state_version: 7,
    instances: {
        alarm_siren: {
            reported: { audible_state: audibleState, mute_until: null },
            desired: {},
        },
        hazard: {
            reported: {
                risk_level: riskLevel,
                incident_state: 'idle',
                active_incident_id: null,
            },
            desired: {},
        },
        gas: {
            reported: { gas_level: 12, calibration_state: 'ready' },
            desired: {},
        },
        smoke: {
            reported: { smoke_level: 4, calibration_state: 'ready' },
            desired: {},
        },
        flame: {
            reported: { flame_detected: false },
            desired: {},
        },
    },
    diagnostics: {},
});

const operation = (
    operationName: 'mute_siren' | 'test_siren',
    durationSeconds: number,
): DeviceOperation => ({
    schema: 'device.operation.v2',
    operation_id: 'operation-1',
    target_device_id: 'AA:BB:CC:DD:EE:FF',
    product_id: product.product_id,
    catalog_revision: 2,
    instance_id: 'alarm_siren',
    operation_name: operationName,
    input: { duration_seconds: durationSeconds },
    context: {},
    issued_at: '2026-08-11T00:00:00.000Z',
    timeout_at: '2026-08-11T00:01:00.000Z',
    route: {
        mode: 'hub',
        network_id: 'network-1',
        topology_epoch: 1,
        hub_mac: 'AA:BB:CC:DD:EE:FF',
    },
});

test('mute plan persists a bounded deadline and restores silently when safe', () => {
    const now = Date.parse('2026-08-11T00:00:00.000Z');
    const plan = sirenTimerPlanForOperation(product, operation('mute_siren', 60), now)!;
    const muted = beginSirenTimer(state('sounding'), plan);

    assert.equal(muted.instances.alarm_siren.reported.audible_state, 'muted');
    assert.equal(muted.instances.alarm_siren.reported.mute_until, '2026-08-11T00:01:00.000Z');
    assert.deepEqual(pendingSirenTimerFromState(product, muted), plan);

    const completed = completeSirenTimer(muted, plan);
    assert.equal(completed.instances.alarm_siren.reported.audible_state, 'silent');
    assert.equal(completed.instances.alarm_siren.reported.mute_until, null);
});

test('expired mute reactivates the siren while danger remains', () => {
    const plan = sirenTimerPlanForOperation(
        product,
        operation('mute_siren', 30),
        Date.parse('2026-08-11T00:00:00.000Z'),
    )!;
    const muted = beginSirenTimer(state('sounding', 'alarm'), plan);
    const completed = completeSirenTimer(muted, plan);

    assert.equal(completed.instances.alarm_siren.reported.audible_state, 'sounding');
});

test('simulator rejects unsupported mute durations and unsafe siren tests', () => {
    assert.throws(
        () => sirenTimerPlanForOperation(product, operation('mute_siren', 120)),
        /not allowed/,
    );
    const testPlan = sirenTimerPlanForOperation(product, operation('test_siren', 5))!;
    assert.throws(
        () => assertSirenOperationAllowed(state('silent', 'emergency'), testPlan),
        /hazard is active/,
    );
});

test('a stale timer cannot override a newer mute deadline', () => {
    const oldPlan = sirenTimerPlanForOperation(product, operation('mute_siren', 30), 0)!;
    const newPlan = sirenTimerPlanForOperation(product, operation('mute_siren', 60), 0)!;
    const muted = beginSirenTimer(state('sounding'), newPlan);

    assert.equal(completeSirenTimer(muted, oldPlan), muted);
});

test('physical panel actions use the same bounded Product contract', () => {
    const plan = sirenTimerPlanForPhysicalAction(product, 'mute_siren', 60, 1_000);
    assert.deepEqual(plan, {
        instanceId: 'alarm_siren',
        mode: 'mute',
        deadlineMs: 61_000,
    });
    assert.throws(
        () => sirenTimerPlanForPhysicalAction(product, 'mute_siren', 120),
        /not allowed/,
    );
});

test('simulated sensor changes derive risk and local siren state like firmware', () => {
    const changed = state('silent');
    changed.instances.gas.reported.gas_level = 80;

    const alarm = reconcileHazardSafetyState(changed, product, 10_000);
    assert.equal(alarm.instances.hazard.reported.risk_level, 'alarm');
    assert.equal(alarm.instances.hazard.reported.incident_state, 'active');
    assert.equal(alarm.instances.alarm_siren.reported.audible_state, 'sounding');

    alarm.instances.flame.reported.flame_detected = true;
    const emergency = reconcileHazardSafetyState(alarm, product, 11_000);
    assert.equal(emergency.instances.hazard.reported.risk_level, 'emergency');
});
