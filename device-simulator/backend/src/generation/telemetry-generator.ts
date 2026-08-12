import type {
    CapabilityOperation,
    CapabilityProperty,
    ProductCatalog,
    ValueSchema,
} from '../catalog/loader';
import {
    validateOperationInput,
    validateValueAgainstSchema,
} from './operation-validation';

export interface DeviceState {
    state_version: number;
    instances: Record<string, {
        reported: Record<string, unknown>;
        desired: Record<string, unknown>;
    }>;
    diagnostics: Record<string, Record<string, unknown>>;
}

export interface DeviceStatePatch {
    instances?: Record<string, {
        reported?: Record<string, unknown>;
        desired?: Record<string, unknown>;
    }>;
    diagnostics?: Record<string, Record<string, unknown>>;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const isCatalogConstant = (property: CapabilityProperty): boolean =>
    property.state_authority === 'product_catalog';

export const removeCatalogConstants = (
    current: DeviceState,
    product: ProductCatalog,
): DeviceState => {
    const next = clone(current);
    const instances = new Map(
        product.capability_instances.map(instance => [instance.instance_id, instance]),
    );

    // A restored registry snapshot may come from an older Product revision.
    // Never publish properties that are no longer part of the active contract.
    for (const [instanceId, envelope] of Object.entries(next.instances)) {
        const instance = instances.get(instanceId);
        if (!instance) {
            delete next.instances[instanceId];
            continue;
        }
        for (const channel of ['reported', 'desired'] as const) {
            const allowed = new Set(
                instance.properties
                    .filter(property => (
                        property.channel === channel && !isCatalogConstant(property)
                    ))
                    .map(property => property.id),
            );
            for (const propertyId of Object.keys(envelope[channel] || {})) {
                if (!allowed.has(propertyId)) delete envelope[channel][propertyId];
            }
        }
    }
    for (const [instanceId, values] of Object.entries(next.diagnostics)) {
        const instance = instances.get(instanceId);
        if (!instance) {
            delete next.diagnostics[instanceId];
            continue;
        }
        const allowed = new Set(
            instance.properties
                .filter(property => (
                    property.channel === 'diagnostic' && !isCatalogConstant(property)
                ))
                .map(property => property.id),
        );
        for (const propertyId of Object.keys(values)) {
            if (!allowed.has(propertyId)) delete values[propertyId];
        }
    }

    for (const instance of product.capability_instances) {
        for (const property of instance.properties) {
            if (!isCatalogConstant(property)) continue;
            if (property.channel === 'diagnostic') {
                delete next.diagnostics[instance.instance_id]?.[property.id];
                continue;
            }
            delete next.instances[instance.instance_id]?.[property.channel]?.[property.id];
        }
    }
    return next;
};

const realisticNumbers: Record<string, number> = {
    temperature: 25,
    humidity: 58,
    illuminance: 650,
    moisture_level: 62,
    level_normalized: 72,
    gas_level: 12,
    smoke_level: 4,
    voltage: 220,
    current: 1.2,
    active_power: 264,
    accumulated_energy: 12.5,
    wifi_rssi: -60,
    uptime: 0,
};

const seedValue = (property: CapabilityProperty): unknown => {
    if (
        ['calibration_state', 'sensor_state'].includes(property.id)
        && property.enum?.includes('ready')
    ) {
        return 'ready';
    }
    if (property.default !== null && property.default !== undefined) return clone(property.default);
    if (realisticNumbers[property.id] !== undefined) return realisticNumbers[property.id];
    if (property.type === 'number' || property.type === 'integer') {
        const minimum = property.minimum ?? 0;
        const maximum = property.maximum ?? minimum + 100;
        return property.type === 'integer'
            ? Math.round((minimum + maximum) / 2)
            : Math.round(((minimum + maximum) / 2) * 10) / 10;
    }
    if (property.type === 'boolean') return false;
    if (property.type === 'string') return property.enum?.[0] ?? '';
    if (property.type === 'array') return [];
    return null;
};

export const generateInitialState = (product: ProductCatalog): DeviceState => {
    const source = clone(product.firmware_default_state);
    const state = removeCatalogConstants({
        state_version: 0,
        instances: source.instances || {},
        diagnostics: source.diagnostics || {},
    }, product);
    for (const instance of product.capability_instances) {
        state.instances[instance.instance_id] ||= { reported: {}, desired: {} };
        for (const property of instance.properties) {
            if (isCatalogConstant(property)) continue;
            if (property.channel === 'diagnostic') {
                state.diagnostics[instance.instance_id] ||= {};
                if (state.diagnostics[instance.instance_id][property.id] == null) {
                    state.diagnostics[instance.instance_id][property.id] = seedValue(property);
                }
            } else if (state.instances[instance.instance_id][property.channel][property.id] == null) {
                state.instances[instance.instance_id][property.channel][property.id] = seedValue(property);
            }
        }
    }
    return state;
};

const randomWalk = (value: number, schema: ValueSchema): number => {
    const minimum = schema.minimum ?? value - 10;
    const maximum = schema.maximum ?? value + 10;
    const step = Math.max((maximum - minimum) / 100, schema.type === 'integer' ? 1 : 0.1);
    const next = Math.min(maximum, Math.max(minimum, value + (Math.random() > 0.5 ? step : -step)));
    return schema.type === 'integer' ? Math.round(next) : Math.round(next * 10) / 10;
};

const controlledPaths = (product: ProductCatalog): Set<string> => {
    const paths = new Set<string>();
    for (const operation of Object.values(product.operations)) {
        for (const effect of operation.effects || []) {
            if (effect.property) paths.add(`${operation.instance_id}.${effect.property}`);
        }
    }
    return paths;
};

export const evolveState = (current: DeviceState, product: ProductCatalog): DeviceState => {
    const next = removeCatalogConstants(current, product);
    const controlled = controlledPaths(product);
    let changed = false;
    for (const instance of product.capability_instances) {
        for (const property of instance.properties) {
            if (isCatalogConstant(property)) continue;
            if (!['number', 'integer'].includes(property.type)) continue;
            if (property.channel === 'reported') {
                if (controlled.has(`${instance.instance_id}.${property.id}`)) continue;
                const value = next.instances[instance.instance_id]?.reported[property.id];
                if (typeof value === 'number') {
                    next.instances[instance.instance_id].reported[property.id] = randomWalk(value, property);
                    changed = true;
                }
            } else if (property.channel === 'diagnostic') {
                const value = next.diagnostics[instance.instance_id]?.[property.id];
                if (typeof value !== 'number') continue;
                next.diagnostics[instance.instance_id][property.id] = property.id === 'uptime'
                    ? value + 1
                    : randomWalk(value, property);
                changed = true;
            }
        }
    }
    if (changed) next.state_version += 1;
    return next;
};

function effectValue(effect: { value?: unknown; value_from?: string }, input: Record<string, unknown>) {
    if (effect.value_from?.startsWith('input.')) return input[effect.value_from.slice(6)];
    return effect.value;
}

function inferredReportedValue(operationName: string, schema?: CapabilityProperty): unknown {
    const candidates: Record<string, unknown> = {
        lock: 'locked',
        unlock: 'unlocked',
        open: 'open',
        close: 'closed',
        stop: schema?.enum?.includes('stopped') ? 'stopped' : 'idle',
        turn_on: 'on',
        turn_off: 'off',
        start: 'running',
    };
    const candidate = candidates[operationName];
    return schema?.enum?.includes(candidate) ? candidate : undefined;
}

export const applyOperationToState = (
    state: DeviceState,
    product: ProductCatalog,
    input: { instance_id: string; operation_name: string; input: Record<string, unknown> },
): DeviceState => {
    const operation = product.operations[`${input.instance_id}.${input.operation_name}`];
    if (!operation) throw new Error('Operation is not supported by this Product');
    validateOperationInput(operation, input.input);
    const instance = product.capability_instances.find(item => item.instance_id === input.instance_id);
    if (!instance) throw new Error('Operation capability instance is unavailable');
    const next = removeCatalogConstants(state, product);
    next.instances[input.instance_id] ||= { reported: {}, desired: {} };
    for (const effect of operation.effects || []) {
        if (!effect.property) continue;
        const value = effectValue(effect, input.input);
        if (effect.type === 'set_desired') {
            next.instances[input.instance_id].desired[effect.property] = value;
            const reportedProperty = effect.property.startsWith('target_')
                ? effect.property.slice('target_'.length)
                : null;
            if (reportedProperty && instance.properties.some(
                property => property.id === reportedProperty && property.channel === 'reported',
            )) {
                next.instances[input.instance_id].reported[reportedProperty] = value;
            }
        } else if (effect.type === 'expect_reported') {
            next.instances[input.instance_id].reported[effect.property] = value;
        }
    }
    const ack = (operation as CapabilityOperation & {
        ack_policy?: { completion_signal?: string; reference?: string };
    }).ack_policy;
    if (ack?.completion_signal === 'reported_state' && ack.reference) {
        const property = instance.properties.find(item => item.id === ack.reference);
        if (next.instances[input.instance_id].reported[ack.reference] === undefined) {
            const inferred = inferredReportedValue(input.operation_name, property);
            if (inferred !== undefined) {
                next.instances[input.instance_id].reported[ack.reference] = inferred;
            }
        }
    }
    next.state_version += 1;
    return next;
};

export const patchDeviceState = (
    state: DeviceState,
    product: ProductCatalog,
    patch: DeviceStatePatch,
): DeviceState => {
    validateDeviceStatePatch(product, patch);
    const next = removeCatalogConstants(state, product);
    for (const [instanceId, envelope] of Object.entries(patch.instances || {})) {
        next.instances[instanceId] ||= { reported: {}, desired: {} };
        for (const channel of ['reported', 'desired'] as const) {
            for (const [propertyId, value] of Object.entries(envelope[channel] || {})) {
                next.instances[instanceId][channel][propertyId] = value;
            }
        }
    }
    for (const [instanceId, values] of Object.entries(patch.diagnostics || {})) {
        next.diagnostics[instanceId] ||= {};
        for (const [propertyId, value] of Object.entries(values)) {
            next.diagnostics[instanceId][propertyId] = value;
        }
    }
    next.state_version += 1;
    return next;
};

export const validateDeviceStatePatch = (
    product: ProductCatalog,
    patch: DeviceStatePatch,
): void => {
    for (const [instanceId, envelope] of Object.entries(patch.instances || {})) {
        const definition = product.capability_instances.find(item => item.instance_id === instanceId);
        if (!definition) throw new Error(`Unknown capability instance ${instanceId}`);
        for (const channel of ['reported', 'desired'] as const) {
            for (const [propertyId, value] of Object.entries(envelope[channel] || {})) {
                const property = definition.properties.find(item => (
                    item.id === propertyId && item.channel === channel
                ));
                if (!property) throw new Error(
                    `Unknown ${channel} property ${instanceId}.${propertyId}`,
                );
                if (isCatalogConstant(property)) throw new Error(
                    `Product Catalog constant ${instanceId}.${propertyId} cannot be patched`,
                );
                validateValueAgainstSchema(value, property, `${instanceId}.${channel}.${propertyId}`);
            }
        }
    }
    for (const [instanceId, values] of Object.entries(patch.diagnostics || {})) {
        const definition = product.capability_instances.find(item => item.instance_id === instanceId);
        if (!definition) throw new Error(`Unknown diagnostic instance ${instanceId}`);
        for (const [propertyId, value] of Object.entries(values)) {
            const property = definition.properties.find(item => (
                item.id === propertyId && item.channel === 'diagnostic'
            ));
            if (!property) throw new Error(`Unknown diagnostic property ${instanceId}.${propertyId}`);
            if (isCatalogConstant(property)) throw new Error(
                `Product Catalog constant ${instanceId}.${propertyId} cannot be patched`,
            );
            validateValueAgainstSchema(value, property, `${instanceId}.diagnostic.${propertyId}`);
        }
    }
};
