import test from 'node:test';
import assert from 'node:assert/strict';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { compileCatalog, loadCatalogV2 } = require('../../../shared/catalog-v2');
import { evolveState, generateInitialState } from '../src/generation/telemetry-generator';
import { reconcileHazardSafetyState } from '../src/runtime/hazard-siren';

const products = compileCatalog(loadCatalogV2()).product_index as Record<string, any>;

test('a new virtual hazard controller reports ready sensors and a normal risk, not a sensor fault', () => {
    const product = products.prod_hazard_mitigation;
    const state = reconcileHazardSafetyState(generateInitialState(product), product);
    assert.equal(state.instances.kitchen_gas.reported.calibration_state, 'ready');
    assert.equal(state.instances.kitchen_smoke.reported.calibration_state, 'ready');
    assert.equal(state.instances.hazard.reported.risk_level, 'normal');
});

test('irrigation sensors finish warm-up so watering is not refused', () => {
    const state = generateInitialState(products.prod_irrigation_manager);
    assert.equal(state.instances.main_garden.reported.sensor_state, 'ready');
    assert.equal(state.instances.reservoir.reported.sensor_state, 'ready');
});

test('a device saved while warming up recovers on its next telemetry tick; a real fault stays', () => {
    const product = products.prod_hazard_mitigation;
    const saved = generateInitialState(product);
    saved.instances.kitchen_gas.reported.calibration_state = 'unknown';
    saved.instances.kitchen_smoke.reported.calibration_state = 'fault';
    const next = reconcileHazardSafetyState(evolveState(saved, product), product);
    assert.equal(next.instances.kitchen_gas.reported.calibration_state, 'ready');
    assert.equal(next.instances.kitchen_smoke.reported.calibration_state, 'fault');
    assert.equal(next.instances.hazard.reported.risk_level, 'sensor_fault');
});
