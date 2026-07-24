import { ProductCatalog } from '../catalog/loader';

export interface DeviceState {
    metrics: Record<string, any>;
    diagnostics: Record<string, any>;
}

/**
 * Applies a random walk to a numeric value within min/max bounds.
 */
const randomWalk = (current: number, min: number, max: number, step: number): number => {
    const direction = Math.random() > 0.5 ? 1 : -1;
    let next = current + (direction * step);
    if (next < min) next = min;
    if (next > max) next = max;
    // Keep 1 decimal place if step is a float
    return step % 1 !== 0 ? Math.round(next * 10) / 10 : Math.round(next);
};

export const generateInitialState = (product: ProductCatalog): DeviceState => {
    const state: DeviceState = { metrics: {}, diagnostics: {} };
    
    // In a real implementation, we'd inspect product.capabilities.
    // For now, we mock some common ones if capabilities is empty or missing.
    // A robust version would parse the exact capability definitions.
    
    state.metrics['power'] = true;
    state.metrics['brightness'] = 80;
    
    // Simulate typical diagnostics
    state.diagnostics['rssi'] = -60;
    state.diagnostics['battery'] = 100;
    
    return state;
};

export const evolveState = (currentState: DeviceState, product: ProductCatalog): DeviceState => {
    const nextState = { 
        metrics: { ...currentState.metrics }, 
        diagnostics: { ...currentState.diagnostics } 
    };

    // Evolve brightness (example numeric capability)
    if (typeof nextState.metrics['brightness'] === 'number') {
        nextState.metrics['brightness'] = randomWalk(nextState.metrics['brightness'], 10, 100, 5);
    }
    
    // Evolve power (example enum/boolean capability - maybe toggles 1% of the time)
    if (typeof nextState.metrics['power'] === 'boolean' && Math.random() < 0.01) {
        nextState.metrics['power'] = !nextState.metrics['power'];
    }

    // Evolve RSSI
    if (typeof nextState.diagnostics['rssi'] === 'number') {
        nextState.diagnostics['rssi'] = randomWalk(nextState.diagnostics['rssi'], -90, -40, 2);
    }
    
    // Evolve Battery (slowly degrades)
    if (typeof nextState.diagnostics['battery'] === 'number' && Math.random() < 0.05) {
        nextState.diagnostics['battery'] = Math.max(0, nextState.diagnostics['battery'] - 1);
    }

    return nextState;
};
