import type {
    CapabilityCommand,
    CapabilityInstance,
    ProductCatalog,
    StateProperty,
} from '../catalog/loader';

export interface DeviceState {
    metrics: Record<string, unknown>;
    diagnostics: Record<string, unknown>;
}

const randomWalk = (current: number, min: number, max: number, step: number): number => {
    const direction = Math.random() > 0.5 ? 1 : -1;
    let next = current + direction * step;
    if (next < min) next = min;
    if (next > max) next = max;
    return step % 1 !== 0 ? Math.round(next * 10) / 10 : Math.round(next);
};

const realisticNumberDefaults: Record<string, number> = {
    temperature: 25,
    humidity: 58,
    light_level: 650,
    soil_moisture: 62,
    water_level: 72,
    gas_level: 120,
    smoke_level: 4,
    voltage: 220,
    current: 1.2,
    active_power: 264,
    energy_accumulated: 12.5,
    rssi: -60,
    uptime_seconds: 0,
    free_heap: 180000,
    min_free_heap: 150000,
    memory_fragmentation: 4,
    flash_usage_bytes: 420000,
    cpu_temperature: 42,
    mqtt_latency_ms: 18,
    boot_count: 1,
    watchdog_resets: 0,
    last_ota_timestamp: 0,
};

const defaultValueForProperty = (key: string, property: StateProperty): unknown => {
    if (property.validation?.enum?.length) return property.validation.enum[0];
    if (property.value_type === 'boolean') return false;
    if (property.value_type === 'string') {
        if (key === 'firmware_version') return 'sim-1.0.0';
        if (key === 'restart_reason') return 'simulator_start';
        return '';
    }
    if (property.value_type === 'number') {
        const configured = realisticNumberDefaults[key];
        if (configured !== undefined) return configured;
        const min = property.validation?.min ?? 0;
        const max = property.validation?.max ?? min + 100;
        return Math.round(((min + max) / 2) * 10) / 10;
    }
    return null;
};

const getInstances = (product: ProductCatalog): CapabilityInstance[] =>
    Array.isArray(product.capabilityInstances) ? product.capabilityInstances : [];

export const generateInitialState = (product: ProductCatalog): DeviceState => {
    const state: DeviceState = {
        metrics: { ...(product.default_state || {}) },
        diagnostics: {},
    };

    for (const instance of getInstances(product)) {
        for (const [key, property] of Object.entries(instance.state_properties || {})) {
            if (state.metrics[key] === undefined || state.metrics[key] === null) {
                state.metrics[key] = defaultValueForProperty(key, property);
            }
        }
        for (const [key, property] of Object.entries(instance.diagnostic_properties || {})) {
            state.diagnostics[key] = defaultValueForProperty(key, property);
        }
    }
    return state;
};

const commandControlledKeys = (product: ProductCatalog): Set<string> => {
    const keys = new Set<string>();
    for (const instance of getInstances(product)) {
        if (!instance.commands?.length) continue;
        for (const stateKey of Object.keys(instance.state_properties || {})) {
            keys.add(stateKey);
        }
    }
    return keys;
};

export const evolveState = (currentState: DeviceState, product: ProductCatalog): DeviceState => {
    const nextState: DeviceState = {
        metrics: { ...currentState.metrics },
        diagnostics: { ...currentState.diagnostics },
    };
    const controlledKeys = commandControlledKeys(product);

    for (const instance of getInstances(product)) {
        for (const [key, property] of Object.entries(instance.state_properties || {})) {
            const current = nextState.metrics[key];
            if (controlledKeys.has(key) || typeof current !== 'number') continue;
            const min = property.validation?.min ?? current - 100;
            const max = property.validation?.max ?? current + 100;
            const step = Math.max((max - min) / 100, 0.1);
            nextState.metrics[key] = randomWalk(current, min, max, step);
        }
    }

    for (const instance of getInstances(product)) {
        for (const [key, property] of Object.entries(instance.diagnostic_properties || {})) {
            const current = nextState.diagnostics[key];
            if (key === 'uptime_seconds' && typeof current === 'number') {
                nextState.diagnostics[key] = current + 1;
                continue;
            }
            if (typeof current !== 'number') continue;
            const min = property.validation?.min ?? realisticNumberDefaults[key] ?? current - 10;
            const max = property.validation?.max ?? current + 10;
            const step = key === 'rssi' ? 2 : Math.max((max - min) / 200, 0.1);
            nextState.diagnostics[key] = randomWalk(current, min, max, step);
        }
    }

    return nextState;
};

export const applyCommandToState = (
    state: DeviceState,
    product: ProductCatalog,
    input: {
        capability_id?: string;
        instance?: string;
        action: string;
        payload?: Record<string, unknown>;
    },
): DeviceState => {
    const candidates = getInstances(product).filter((instance) =>
        (!input.capability_id || instance.capability_id === input.capability_id)
        && (!input.instance || instance.instance === input.instance)
        && instance.commands?.some((command) => command.action === input.action),
    );
    if (candidates.length !== 1) {
        throw new Error(candidates.length === 0
            ? `Unsupported command action ${input.action}`
            : `Command action ${input.action} is ambiguous without capability instance`);
    }

    const instance = candidates[0];
    const command = instance.commands.find((item) => item.action === input.action) as CapabilityCommand;
    const payload = input.payload || {};
    for (const argument of command.arguments || []) {
        if (!(argument.name in payload)) {
            throw new Error(`Missing command argument ${argument.name}`);
        }
    }

    const next: DeviceState = {
        metrics: { ...state.metrics },
        diagnostics: { ...state.diagnostics },
    };
    const stateKeys = Object.keys(instance.state_properties || {});

    for (const argument of command.arguments || []) {
        const value = payload[argument.name];
        let stateKey = argument.name;
        if (!(stateKey in instance.state_properties) && argument.name === 'value' && stateKeys.length === 1) {
            stateKey = stateKeys[0];
        }
        if (input.action === 'SET_POSITION' && argument.name === 'position') stateKey = 'target_position';
        if (input.action === 'SET_RECOGNITION_MODE' && argument.name === 'enabled') stateKey = 'recognition_enabled';
        if (input.action === 'DISPLAY_TEXT' && argument.name === 'text') stateKey = 'displayed_text';
        if (stateKey in next.metrics || stateKey in instance.state_properties) {
            next.metrics[stateKey] = value;
        }
    }

    switch (input.action) {
        case 'LOCK':
            next.metrics.lock_state = 'locked';
            break;
        case 'UNLOCK':
            next.metrics.lock_state = 'unlocked';
            break;
        case 'OPEN':
            next.metrics.target_position = 100;
            next.metrics.current_position = 100;
            next.metrics.movement_status = 'stopped';
            break;
        case 'CLOSE':
            next.metrics.target_position = 0;
            next.metrics.current_position = 0;
            next.metrics.movement_status = 'stopped';
            break;
        case 'STOP':
            next.metrics.movement_status = 'stopped';
            break;
        case 'SET_POSITION':
            next.metrics.current_position = next.metrics.target_position;
            next.metrics.movement_status = 'stopped';
            break;
        case 'START_STREAM':
            next.metrics.is_streaming = true;
            break;
        case 'STOP_STREAM':
            next.metrics.is_streaming = false;
            break;
        case 'TAKE_SNAPSHOT':
            next.metrics.snapshot_taken_at = new Date().toISOString();
            break;
        case 'CLEAR_DISPLAY':
            next.metrics.displayed_text = '';
            break;
        case 'RESET_ENERGY':
            next.metrics.energy_accumulated = 0;
            break;
    }

    return next;
};
