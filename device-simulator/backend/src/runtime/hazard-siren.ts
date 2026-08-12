import type { ProductCatalog } from '../catalog/loader';
import type { DeviceOperation } from '../generation/operation-validation';
import type { DeviceState } from '../generation/telemetry-generator';

export const ALLOWED_MUTE_DURATIONS_SECONDS = [60, 180, 300, 600, 1800] as const;
export const SIMULATED_HAZARD_THRESHOLDS = {
    gasWarning: 50,
    gasAlarm: 70,
    smokeWarning: 45,
    smokeAlarm: 65,
} as const;

export interface SirenTimerPlan {
    instanceId: string;
    mode: 'test' | 'mute';
    deadlineMs: number;
}

export type PhysicalSirenAction = 'test_siren' | 'mute_siren' | 'resume_siren';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const sirenInstance = (product: ProductCatalog, instanceId: string) => {
    const instance = product.capability_instances.find(item => (
        item.instance_id === instanceId && item.capability_id === 'alarm_siren'
    ));
    if (!instance) return undefined;
    const state = instance.properties.find(property => (
        property.id === 'audible_state'
        && property.channel === 'reported'
        && property.enum?.includes('silent')
        && property.enum.includes('sounding')
        && property.enum.includes('muted')
    ));
    const deadline = instance.properties.find(property => (
        property.id === 'mute_until'
        && property.channel === 'reported'
        && property.type === 'string'
    ));
    return state && deadline ? instance : undefined;
};

const requiredDuration = (operation: DeviceOperation): number => {
    const duration = operation.input.duration_seconds;
    if (!Number.isInteger(duration)) {
        throw new Error('Siren duration_seconds must be an integer');
    }
    return Number(duration);
};

const planForDuration = (
    product: ProductCatalog,
    instanceId: string,
    operationName: PhysicalSirenAction,
    duration: number,
    nowMs: number,
): SirenTimerPlan => {
    const compiledOperation = product.operations[`${instanceId}.${operationName}`];
    if (
        compiledOperation?.capability_id !== 'alarm_siren'
        || !sirenInstance(product, instanceId)
    ) {
        throw new Error('This Product does not expose a physical siren');
    }
    if (operationName === 'test_siren') {
        if (!Number.isInteger(duration) || duration < 1 || duration > 30) {
            throw new Error('Siren test duration must be between 1 and 30 seconds');
        }
        return {
            instanceId,
            mode: 'test',
            deadlineMs: nowMs + duration * 1_000,
        };
    }
    if (!Number.isInteger(duration) || !ALLOWED_MUTE_DURATIONS_SECONDS.includes(
        duration as typeof ALLOWED_MUTE_DURATIONS_SECONDS[number],
    )) {
        throw new Error('Siren mute duration is not allowed');
    }
    return {
        instanceId,
        mode: 'mute',
        deadlineMs: nowMs + duration * 1_000,
    };
};

export const sirenTimerPlanForPhysicalAction = (
    product: ProductCatalog,
    action: Exclude<PhysicalSirenAction, 'resume_siren'>,
    durationSeconds: number,
    nowMs = Date.now(),
): SirenTimerPlan => {
    const instance = product.capability_instances.find(item => (
        item.capability_id === 'alarm_siren'
        && product.operations[`${item.instance_id}.${action}`]
    ));
    if (!instance) throw new Error('This Product does not support the requested siren action');
    return planForDuration(product, instance.instance_id, action, durationSeconds, nowMs);
};

export const sirenResumeInstanceForOperation = (
    product: ProductCatalog,
    operation: DeviceOperation,
): string | undefined => {
    if (operation.operation_name !== 'resume_siren') return undefined;
    const compiledOperation = product.operations[
        `${operation.instance_id}.${operation.operation_name}`
    ];
    if (
        compiledOperation?.capability_id !== 'alarm_siren'
        || !sirenInstance(product, operation.instance_id)
    ) {
        return undefined;
    }
    return operation.instance_id;
};

export const resumeSiren = (
    state: DeviceState,
    instanceId: string,
    incrementVersion = true,
): DeviceState => {
    const reported = state.instances[instanceId]?.reported;
    if (!reported) return state;
    const nextAudible = hasActiveHazard(state) ? 'sounding' : 'silent';
    if (reported.audible_state === nextAudible && reported.mute_until == null) {
        return state;
    }
    const next = clone(state);
    next.instances[instanceId].reported.audible_state = nextAudible;
    next.instances[instanceId].reported.mute_until = null;
    if (incrementVersion) next.state_version += 1;
    return next;
};

export const hasActiveHazard = (state: DeviceState): boolean => {
    const hazard = state.instances.hazard?.reported || {};
    const riskLevel = String(hazard.risk_level || '').toLowerCase();
    if (['alarm', 'emergency'].includes(riskLevel)) return true;
    return Object.values(state.instances).some(envelope => (
        envelope.reported.flame_detected === true
    ));
};

const firstReportedValue = (state: DeviceState, propertyId: string): unknown => {
    for (const envelope of Object.values(state.instances)) {
        if (Object.prototype.hasOwnProperty.call(envelope.reported, propertyId)) {
            return envelope.reported[propertyId];
        }
    }
    return undefined;
};

const simulatedRiskLevel = (state: DeviceState): string => {
    const flameDetected = Object.values(state.instances).some(envelope => (
        envelope.reported.flame_detected === true
    ));
    if (flameDetected) return 'emergency';

    const gasLevel = Number(firstReportedValue(state, 'gas_level'));
    const smokeLevel = Number(firstReportedValue(state, 'smoke_level'));
    if (
        gasLevel >= SIMULATED_HAZARD_THRESHOLDS.gasAlarm
        || smokeLevel >= SIMULATED_HAZARD_THRESHOLDS.smokeAlarm
    ) {
        return 'alarm';
    }

    const calibrationStates = Object.values(state.instances)
        .map(envelope => envelope.reported.calibration_state)
        .filter(value => value !== undefined);
    if (calibrationStates.some(value => value !== 'ready')) return 'sensor_fault';
    if (
        gasLevel >= SIMULATED_HAZARD_THRESHOLDS.gasWarning
        || smokeLevel >= SIMULATED_HAZARD_THRESHOLDS.smokeWarning
    ) {
        return 'warning';
    }
    return 'normal';
};

export const reconcileHazardSafetyState = (
    state: DeviceState,
    product: ProductCatalog,
    nowMs = Date.now(),
): DeviceState => {
    const hazardInstance = product.capability_instances.find(instance => (
        instance.capability_id === 'hazard_controller'
    ));
    const alarmInstance = product.capability_instances.find(instance => (
        instance.capability_id === 'alarm_siren'
    ));
    if (!hazardInstance || !alarmInstance) return state;

    const previousRisk = String(
        state.instances[hazardInstance.instance_id]?.reported.risk_level || '',
    );
    const nextRisk = simulatedRiskLevel(state);
    const previousHazard = ['alarm', 'emergency'].includes(previousRisk);
    const nextHazard = ['alarm', 'emergency'].includes(nextRisk);
    const alarmReported = state.instances[alarmInstance.instance_id]?.reported || {};
    const audibleState = String(alarmReported.audible_state || 'silent');
    const muteDeadline = typeof alarmReported.mute_until === 'string'
        ? Date.parse(alarmReported.mute_until)
        : Number.NaN;
    const muteActive = Number.isFinite(muteDeadline) && muteDeadline > nowMs;
    const nextAudible = muteActive
        ? 'muted'
        : nextHazard
            ? 'sounding'
        : previousHazard && ['sounding', 'muted'].includes(audibleState)
            ? 'silent'
            : audibleState === 'muted'
                ? 'silent'
            : audibleState;
    const nextMuteUntil = muteActive
        ? alarmReported.mute_until
        : null;

    const hazardReported = state.instances[hazardInstance.instance_id]?.reported || {};
    const startsIncident = nextHazard && hazardReported.incident_state === 'idle';
    if (
        previousRisk === nextRisk
        && audibleState === nextAudible
        && (alarmReported.mute_until ?? null) === nextMuteUntil
        && !startsIncident
    ) {
        return state;
    }

    const next = clone(state);
    next.instances[hazardInstance.instance_id] ||= { reported: {}, desired: {} };
    next.instances[alarmInstance.instance_id] ||= { reported: {}, desired: {} };
    next.instances[hazardInstance.instance_id].reported.risk_level = nextRisk;
    next.instances[alarmInstance.instance_id].reported.audible_state = nextAudible;
    next.instances[alarmInstance.instance_id].reported.mute_until = nextMuteUntil;
    if (startsIncident) {
        next.instances[hazardInstance.instance_id].reported.incident_state = 'active';
        next.instances[hazardInstance.instance_id].reported.active_incident_id =
            `simulated-incident-${nowMs}`;
    }
    next.state_version += 1;
    return next;
};

export const sirenTimerPlanForOperation = (
    product: ProductCatalog,
    operation: DeviceOperation,
    nowMs = Date.now(),
): SirenTimerPlan | undefined => {
    const compiledOperation = product.operations[
        `${operation.instance_id}.${operation.operation_name}`
    ];
    if (
        compiledOperation?.capability_id !== 'alarm_siren'
        || !sirenInstance(product, operation.instance_id)
    ) {
        return undefined;
    }

    if (
        operation.operation_name === 'test_siren'
        || operation.operation_name === 'mute_siren'
    ) {
        return planForDuration(
            product,
            operation.instance_id,
            operation.operation_name,
            requiredDuration(operation),
            nowMs,
        );
    }
    return undefined;
};

export const assertSirenOperationAllowed = (
    state: DeviceState,
    plan?: SirenTimerPlan,
): void => {
    if (!plan) return;
    const audibleState = state.instances[plan.instanceId]?.reported.audible_state;
    if (plan.mode === 'test' && hasActiveHazard(state)) {
        throw new Error('Cannot test the siren while a hazard is active');
    }
    if (plan.mode === 'test' && audibleState === 'muted') {
        throw new Error('Cannot test the siren while it is muted');
    }
};

export const beginSirenTimer = (
    state: DeviceState,
    plan: SirenTimerPlan,
    incrementVersion = true,
): DeviceState => {
    const next = clone(state);
    next.instances[plan.instanceId] ||= { reported: {}, desired: {} };
    next.instances[plan.instanceId].reported.audible_state = plan.mode === 'test'
        ? 'sounding'
        : 'muted';
    next.instances[plan.instanceId].reported.mute_until = plan.mode === 'mute'
        ? new Date(plan.deadlineMs).toISOString()
        : null;
    if (incrementVersion) next.state_version += 1;
    return next;
};

export const completeSirenTimer = (
    state: DeviceState,
    plan: SirenTimerPlan,
): DeviceState => {
    const reported = state.instances[plan.instanceId]?.reported;
    if (!reported) return state;
    if (
        plan.mode === 'mute'
        && reported.mute_until !== new Date(plan.deadlineMs).toISOString()
    ) {
        return state;
    }
    if (plan.mode === 'test' && reported.audible_state !== 'sounding') return state;

    const nextState = hasActiveHazard(state) ? 'sounding' : 'silent';
    if (reported.audible_state === nextState && reported.mute_until == null) return state;
    const next = clone(state);
    next.instances[plan.instanceId].reported.audible_state = nextState;
    next.instances[plan.instanceId].reported.mute_until = null;
    next.state_version += 1;
    return next;
};

export const pendingSirenTimerFromState = (
    product: ProductCatalog,
    state: DeviceState,
): SirenTimerPlan | undefined => {
    for (const instance of product.capability_instances) {
        if (!sirenInstance(product, instance.instance_id)) continue;
        const reported = state.instances[instance.instance_id]?.reported;
        if (reported?.audible_state !== 'muted' || typeof reported.mute_until !== 'string') {
            continue;
        }
        const deadlineMs = Date.parse(reported.mute_until);
        if (!Number.isFinite(deadlineMs)) continue;
        return { instanceId: instance.instance_id, mode: 'mute', deadlineMs };
    }
    return undefined;
};

export const normalizeSirenState = (
    state: DeviceState,
    product: ProductCatalog,
): DeviceState => {
    let next = state;
    for (const instance of product.capability_instances) {
        if (!sirenInstance(product, instance.instance_id)) continue;
        const reported = next.instances[instance.instance_id]?.reported;
        const audible = reported?.audible_state;
        if (['silent', 'sounding', 'muted'].includes(String(audible))) continue;
        if (next === state) next = clone(state);
        next.instances[instance.instance_id] ||= { reported: {}, desired: {} };
        next.instances[instance.instance_id].reported.audible_state = 'silent';
        next.instances[instance.instance_id].reported.mute_until = null;
        next.state_version += 1;
    }
    return next;
};
