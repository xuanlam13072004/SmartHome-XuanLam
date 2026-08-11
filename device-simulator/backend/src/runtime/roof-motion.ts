import type { ProductCatalog } from '../catalog/loader';
import type { DeviceState } from '../generation/telemetry-generator';

export const SIMULATED_ROOF_MOTION_DURATION_MS = 5_000;

export interface RoofMotionPlan {
    instanceId: string;
    movingState: 'opening' | 'closing';
    finalState: 'open' | 'closed';
    shouldMove: boolean;
}

interface OperationIdentity {
    instance_id: string;
    operation_name: string;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const coverInstance = (product: ProductCatalog, instanceId: string) => {
    const instance = product.capability_instances.find(item => (
        item.instance_id === instanceId && item.capability_id === 'cover_controller'
    ));
    const movement = instance?.properties.find(property => (
        property.id === 'movement' && property.channel === 'reported'
    ));
    if (
        !instance
        || !movement?.enum?.includes('closed')
        || !movement.enum.includes('opening')
        || !movement.enum.includes('open')
        || !movement.enum.includes('closing')
    ) {
        return undefined;
    }
    return instance;
};

export const roofMotionPlanForOperation = (
    product: ProductCatalog,
    operation: OperationIdentity,
    state: DeviceState,
): RoofMotionPlan | undefined => {
    const compiledOperation = product.operations[
        `${operation.instance_id}.${operation.operation_name}`
    ];
    if (
        compiledOperation?.capability_id !== 'cover_controller'
        || !['open', 'close'].includes(operation.operation_name)
        || !coverInstance(product, operation.instance_id)
    ) {
        return undefined;
    }

    const opening = operation.operation_name === 'open';
    const finalState = opening ? 'open' : 'closed';
    return {
        instanceId: operation.instance_id,
        movingState: opening ? 'opening' : 'closing',
        finalState,
        shouldMove: state.instances[operation.instance_id]?.reported.movement !== finalState,
    };
};

export const pendingRoofMotionFromState = (
    product: ProductCatalog,
    state: DeviceState,
): RoofMotionPlan | undefined => {
    for (const instance of product.capability_instances) {
        if (!coverInstance(product, instance.instance_id)) continue;
        const current = state.instances[instance.instance_id]?.reported.movement;
        if (current === 'opening' || current === 'closing') {
            return {
                instanceId: instance.instance_id,
                movingState: current,
                finalState: current === 'opening' ? 'open' : 'closed',
                shouldMove: true,
            };
        }
    }
    return undefined;
};

export const automaticRainClosePlan = (
    product: ProductCatalog,
    state: DeviceState,
): RoofMotionPlan | undefined => {
    const automatic = product.capability_instances.some(instance => (
        instance.capability_id === 'roof_policy'
        && state.instances[instance.instance_id]?.reported.control_mode === 'automatic'
    ));
    const raining = product.capability_instances.some(instance => (
        instance.capability_id === 'rain_detection'
        && state.instances[instance.instance_id]?.reported.rain_detected === true
    ));
    if (!automatic || !raining) return undefined;

    const instance = product.capability_instances.find(item => (
        item.capability_id === 'cover_controller'
        && coverInstance(product, item.instance_id)
    ));
    if (!instance) return undefined;
    return {
        instanceId: instance.instance_id,
        movingState: 'closing',
        finalState: 'closed',
        shouldMove: state.instances[instance.instance_id]?.reported.movement !== 'closed',
    };
};

export const beginRoofMotion = (
    state: DeviceState,
    plan: RoofMotionPlan,
): DeviceState => {
    if (!plan.shouldMove) return state;
    if (state.instances[plan.instanceId]?.reported.movement === plan.movingState) return state;
    const next = clone(state);
    next.instances[plan.instanceId] ||= { reported: {}, desired: {} };
    next.instances[plan.instanceId].reported.movement = plan.movingState;
    next.state_version += 1;
    return next;
};

export const completeRoofMotion = (
    state: DeviceState,
    plan: RoofMotionPlan,
): DeviceState => {
    if (state.instances[plan.instanceId]?.reported.movement !== plan.movingState) {
        return state;
    }
    const next = clone(state);
    next.instances[plan.instanceId].reported.movement = plan.finalState;
    next.state_version += 1;
    return next;
};

export const normalizeRoofMotionState = (
    state: DeviceState,
    product: ProductCatalog,
): DeviceState => {
    let next = state;
    for (const instance of product.capability_instances) {
        if (!coverInstance(product, instance.instance_id)) continue;
        const current = next.instances[instance.instance_id]?.reported.movement;
        if (['closed', 'opening', 'open', 'closing'].includes(String(current))) continue;
        if (next === state) next = clone(state);
        next.instances[instance.instance_id] ||= { reported: {}, desired: {} };
        next.instances[instance.instance_id].reported.movement = 'closed';
        next.state_version += 1;
    }
    return next;
};
