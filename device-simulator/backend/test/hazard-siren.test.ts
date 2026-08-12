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
    resumeSiren,
    sirenResumeInstanceForOperation,
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
        'alarm_siren.resume_siren': { capability_id: 'alarm_siren' },
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
    operationName: 'mute_siren' | 'resume_siren' | 'test_siren',
    durationSeconds = 0,
): DeviceOperation => ({
    schema: 'device.operation.v2',
    operation_id: 'operation-1',
    target_device_id: 'AA:BB:CC:DD:EE:FF',
    product_id: product.product_id,
    catalog_revision: 6,
    instance_id: 'alarm_siren',
    operation_name: operationName,
    input: operationName === 'resume_siren'
        ? {}
        : { duration_seconds: durationSeconds },
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
    const muted = beginSirenTimer(state('sounding', 'alarm'), plan);

    assert.equal(muted.instances.alarm_siren.reported.audible_state, 'muted');
    assert.equal(muted.instances.alarm_siren.reported.mute_until, '2026-08-11T00:01:00.000Z');
    assert.deepEqual(pendingSirenTimerFromState(product, muted), plan);

    muted.instances.hazard.reported.risk_level = 'normal';
    const completed = completeSirenTimer(muted, plan);
    assert.equal(completed.instances.alarm_siren.reported.audible_state, 'silent');
    assert.equal(completed.instances.alarm_siren.reported.mute_until, null);
});

test('expired mute reactivates the siren while danger remains', () => {
    const plan = sirenTimerPlanForOperation(
        product,
        operation('mute_siren', 60),
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
    assert.throws(
        () => assertSirenOperationAllowed(state('muted', 'normal'), testPlan),
        /while it is muted/,
    );
});

test('a stale timer cannot override a newer mute deadline', () => {
    const oldPlan = sirenTimerPlanForOperation(product, operation('mute_siren', 60), 0)!;
    const newPlan = sirenTimerPlanForOperation(product, operation('mute_siren', 180), 0)!;
    const muted = beginSirenTimer(state('sounding', 'alarm'), newPlan);

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
    assert.equal(
        sirenTimerPlanForPhysicalAction(product, 'mute_siren', 1800, 1_000).deadlineMs,
        1_801_000,
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

test('standby mute suppresses a later hazard only until its deadline', () => {
    const standby = state('silent', 'normal');
    const plan = sirenTimerPlanForOperation(
        product,
        operation('mute_siren', 180),
        10_000,
    )!;
    assert.doesNotThrow(() => assertSirenOperationAllowed(standby, plan));
    const muted = beginSirenTimer(standby, plan);
    assert.equal(muted.instances.alarm_siren.reported.audible_state, 'muted');

    muted.instances.gas.reported.gas_level = 80;
    const nextAlarm = reconcileHazardSafetyState(muted, product, 20_000);
    assert.equal(nextAlarm.instances.hazard.reported.risk_level, 'alarm');
    assert.equal(nextAlarm.instances.alarm_siren.reported.audible_state, 'muted');

    const expired = completeSirenTimer(nextAlarm, plan);
    assert.equal(expired.instances.alarm_siren.reported.audible_state, 'sounding');
    assert.equal(expired.instances.alarm_siren.reported.mute_until, null);
});

test('resume operation cancels mute immediately and follows current hazard state', () => {
    const resumeOperation = operation('resume_siren');
    assert.equal(
        sirenResumeInstanceForOperation(product, resumeOperation),
        'alarm_siren',
    );

    const safeMuted = beginSirenTimer(
        state('silent', 'normal'),
        sirenTimerPlanForOperation(product, operation('mute_siren', 1800), 0)!,
    );
    const safeResumed = resumeSiren(safeMuted, 'alarm_siren');
    assert.equal(safeResumed.instances.alarm_siren.reported.audible_state, 'silent');
    assert.equal(safeResumed.instances.alarm_siren.reported.mute_until, null);

    const hazardMuted = beginSirenTimer(
        state('sounding', 'alarm'),
        sirenTimerPlanForOperation(product, operation('mute_siren', 1800), 0)!,
    );
    const hazardResumed = resumeSiren(hazardMuted, 'alarm_siren');
    assert.equal(hazardResumed.instances.alarm_siren.reported.audible_state, 'sounding');
    assert.equal(hazardResumed.instances.alarm_siren.reported.mute_until, null);
});
