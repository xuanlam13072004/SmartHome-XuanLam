import crypto from 'node:crypto';
import type { ProductCatalog } from '../catalog/loader';
import type { DeviceState } from '../generation/telemetry-generator';
import { validateOperationInput } from '../generation/operation-validation';
import type { DeviceEventDraft } from './entrance-controller';

export interface IrrigationSession {
    cycle?: { id: string; started_at: number; duration_seconds: number; source: 'remote' | 'local_button' | 'automatic' };
    cooldown_until?: number;
}
export interface IrrigationTransition {
    state: DeviceState;
    session: IrrigationSession;
    events: DeviceEventDraft[];
}

const clone = <T>(value: T): T => structuredClone(value);
const definitions = (product: ProductCatalog) => {
    const find = (id: string) => product.capability_instances.find(i => i.capability_id === id);
    return { pump: find('irrigation_pump'), policy: find('irrigation_policy'), soil: find('soil_moisture_measurement'), reservoir: find('water_level_measurement') };
};
const constants = (product: ProductCatalog) => {
    const { policy } = definitions(product);
    const read = (id: string) => {
        const value = policy?.properties.find(p => p.id === id && p.state_authority === 'product_catalog')?.default;
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Missing irrigation firmware constant ${id}`);
        return value;
    };
    return { target: read('target_moisture'), hysteresis: read('moisture_hysteresis'), duration: read('default_cycle_duration_seconds'), maximum: read('maximum_runtime_seconds'), cooldown: read('cooldown_seconds') };
};
const waterSafety = (state: DeviceState, product: ProductCatalog): 'reservoir_sensor_fault' | 'low_water' | null => {
    const { reservoir } = definitions(product);
    const water = state.instances[reservoir?.instance_id || '']?.reported;
    if (water?.sensor_state !== 'ready') return 'reservoir_sensor_fault';
    return water.water_availability === 'available' ? null : 'low_water';
};
const soilValue = (state: DeviceState, product: ProductCatalog): number | null => {
    const { soil } = definitions(product);
    const values = state.instances[soil?.instance_id || '']?.reported;
    return values?.sensor_state === 'ready' && typeof values.moisture_level === 'number'
        ? values.moisture_level : null;
};

export function initializeIrrigation(state: DeviceState, product: ProductCatalog, stored?: IrrigationSession, now = Date.now()): IrrigationTransition | null {
    const { pump, policy } = definitions(product);
    if (!pump || !policy) return null;
    const next = clone(state);
    const values = next.instances[pump.instance_id].reported;
    const wasRunning = values.pump_output_state === 'running';
    // The catalog requires safe boot: never restart a pump from a stale snapshot.
    values.pump_output_state = 'stopped';
    values.active_cycle_id = null;
    if (wasRunning) {
        values.stop_reason = 'controller_restart';
        next.state_version += 1;
    }
    return {
        state: next,
        session: { cooldown_until: wasRunning ? now + constants(product).cooldown * 1000 : stored?.cooldown_until },
        events: wasRunning && stored?.cycle ? [{ instance_id: pump.instance_id, event_name: 'watering_stopped', data: {
            cycle_id: stored.cycle.id, runtime_seconds: Number(values.runtime_seconds || 0), reason: 'controller_restart',
        } }] : [],
    };
}

export function startIrrigation(state: DeviceState, session: IrrigationSession, product: ProductCatalog, duration: number, source: 'remote' | 'local_button' | 'automatic', now = Date.now()): IrrigationTransition {
    const { pump } = definitions(product);
    if (!pump) throw new Error('Device does not support irrigation');
    const limits = constants(product);
    if (!Number.isInteger(duration) || duration < 30 || duration > limits.maximum) throw new Error(`Irrigation duration must be between 30 and ${limits.maximum} seconds`);
    if (session.cycle || state.instances[pump.instance_id]?.reported.pump_output_state === 'running') throw new Error('An irrigation cycle is already active');
    const safety = waterSafety(state, product);
    if (safety) throw new Error(`Cannot water: ${safety}`);
    if ((session.cooldown_until || 0) > now) throw new Error('Pump cooldown has not finished');
    const next = clone(state);
    const id = crypto.randomUUID();
    Object.assign(next.instances[pump.instance_id].reported, { pump_output_state: 'running', active_cycle_id: id, runtime_seconds: 0, stop_reason: null });
    next.state_version += 1;
    return { state: next, session: { ...session, cycle: { id, started_at: now, duration_seconds: duration, source } }, events: [{ instance_id: pump.instance_id, event_name: 'watering_started', data: { cycle_id: id, duration_seconds: duration, source } }] };
}

export function stopIrrigation(state: DeviceState, session: IrrigationSession, product: ProductCatalog, reason = 'user_request', now = Date.now()): IrrigationTransition {
    const { pump } = definitions(product);
    if (!pump || !session.cycle) return { state, session, events: [] };
    const runtime = Math.max(0, Math.floor((now - session.cycle.started_at) / 1000));
    const next = clone(state);
    Object.assign(next.instances[pump.instance_id].reported, { pump_output_state: 'stopped', active_cycle_id: null, runtime_seconds: runtime, stop_reason: reason });
    next.state_version += 1;
    return { state: next, session: { cooldown_until: now + constants(product).cooldown * 1000 }, events: [{ instance_id: pump.instance_id, event_name: 'watering_stopped', data: { cycle_id: session.cycle.id, runtime_seconds: runtime, reason } }] };
}

export function advanceIrrigation(state: DeviceState, session: IrrigationSession, product: ProductCatalog, now = Date.now()): IrrigationTransition {
    const { pump, policy } = definitions(product);
    if (!pump || !policy) return { state, session, events: [] };
    const limits = constants(product);
    const moisture = soilValue(state, product);
    const automatic = state.instances[policy.instance_id]?.reported.control_mode === 'automatic';
    if (session.cycle) {
        const elapsed = Math.max(0, Math.floor((now - session.cycle.started_at) / 1000));
        const safety = waterSafety(state, product);
        if (safety) return stopIrrigation(state, session, product, safety, now);
        if (elapsed >= session.cycle.duration_seconds) return stopIrrigation(state, session, product, 'completed', now);
        if (elapsed >= limits.maximum) return stopIrrigation(state, session, product, 'maximum_runtime', now);
        if (session.cycle.source === 'automatic') {
            if (!automatic) return stopIrrigation(state, session, product, 'user_request', now);
            if (moisture === null || moisture >= limits.target) return stopIrrigation(state, session, product, 'completed', now);
        }
        if (state.instances[pump.instance_id].reported.runtime_seconds === elapsed) return { state, session, events: [] };
        const next = clone(state);
        next.instances[pump.instance_id].reported.runtime_seconds = elapsed;
        next.state_version += 1;
        return { state: next, session, events: [] };
    }
    if (automatic && moisture !== null && moisture <= limits.target - limits.hysteresis && !waterSafety(state, product) && (session.cooldown_until || 0) <= now) {
        return startIrrigation(state, session, product, limits.duration, 'automatic', now);
    }
    return { state, session, events: [] };
}

export function irrigationOperation(state: DeviceState, session: IrrigationSession, product: ProductCatalog, operation: { instance_id: string; operation_name: string; input: Record<string, unknown> }, now = Date.now()): IrrigationTransition | null {
    const spec = product.operations[`${operation.instance_id}.${operation.operation_name}`];
    if (spec?.capability_id !== 'irrigation_pump') return null;
    validateOperationInput(spec, operation.input);
    if (operation.operation_name === 'stop') return stopIrrigation(state, session, product, 'user_request', now);
    if (operation.operation_name !== 'water_for_duration') throw new Error('Unsupported irrigation operation');
    return startIrrigation(state, session, product, Number(operation.input.duration_seconds), 'remote', now);
}

export function physicalIrrigation(state: DeviceState, session: IrrigationSession, product: ProductCatalog, action: 'start' | 'stop', now = Date.now()): IrrigationTransition {
    return action === 'stop' ? stopIrrigation(state, session, product, 'user_request', now)
        : startIrrigation(state, session, product, constants(product).duration, 'local_button', now);
}
