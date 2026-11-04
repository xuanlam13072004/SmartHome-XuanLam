import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProductCatalog } from '../src/catalog/loader';
import { generateInitialState } from '../src/generation/telemetry-generator';
import { advanceIrrigation, initializeIrrigation, irrigationOperation, physicalIrrigation, startIrrigation, stopIrrigation } from '../src/runtime/irrigation-controller';
import { DeviceRuntime } from '../src/runtime/device-runtime';
const { compileCatalog, loadCatalogV2 } = require('../../../shared/catalog-v2');
const product = compileCatalog(loadCatalogV2()).product_index.prod_irrigation_manager as ProductCatalog;
const boot = () => {
    const result = initializeIrrigation(generateInitialState(product), product, undefined, 0)!;
    Object.assign(result.state.instances.reservoir.reported, { sensor_state: 'ready', water_availability: 'available' });
    Object.assign(result.state.instances.main_garden.reported, { sensor_state: 'ready', moisture_level: 40 });
    return result;
};
const pump = (result: ReturnType<typeof boot>) => result.state.instances.irrigation_pump.reported;

test('a 30-second remote watering cycle counts elapsed seconds and stops at its deadline', () => {
    let result = boot();
    result = irrigationOperation(result.state, result.session, product, { instance_id: 'irrigation_pump', operation_name: 'water_for_duration', input: { duration_seconds: 30 } }, 1000)!;
    assert.equal(pump(result).pump_output_state, 'running');
    assert.equal(result.events[0].data.source, 'remote');
    result = advanceIrrigation(result.state, result.session, product, 16000);
    assert.equal(pump(result).runtime_seconds, 15);
    result = advanceIrrigation(result.state, result.session, product, 31000);
    assert.equal(pump(result).pump_output_state, 'stopped');
    assert.equal(pump(result).runtime_seconds, 30);
    assert.equal(pump(result).stop_reason, 'completed');
    assert.equal(pump(result).active_cycle_id, null);
    assert.throws(() => startIrrigation(result.state, result.session, product, 30, 'remote', 32000), /cooldown/);
    assert.equal(pump(startIrrigation(result.state, result.session, product, 30, 'remote', 91000)).pump_output_state, 'running');
});

test('watering rejects unsafe water, excessive duration and overlapping cycles', () => {
    const result = boot();
    assert.throws(() => startIrrigation(result.state, result.session, product, 901, 'remote', 0), /duration/);
    result.state.instances.reservoir.reported.water_availability = 'empty';
    assert.throws(() => startIrrigation(result.state, result.session, product, 30, 'remote', 0), /low_water/);
    result.state.instances.reservoir.reported.water_availability = 'available';
    result.state.instances.reservoir.reported.sensor_state = 'fault';
    assert.throws(() => startIrrigation(result.state, result.session, product, 30, 'remote', 0), /reservoir_sensor_fault/);
    result.state.instances.reservoir.reported.sensor_state = 'ready';
    const running = startIrrigation(result.state, result.session, product, 30, 'remote', 0);
    assert.throws(() => startIrrigation(running.state, running.session, product, 30, 'remote', 0), /already active/);
});

test('water loss and a manual stop terminate a cycle with the correct reason', () => {
    let result = boot();
    result = startIrrigation(result.state, result.session, product, 300, 'remote', 0);
    result.state.instances.reservoir.reported.water_availability = 'low';
    result = advanceIrrigation(result.state, result.session, product, 5000);
    assert.equal(pump(result).stop_reason, 'low_water');
    result = boot();
    result = physicalIrrigation(result.state, result.session, product, 'start', 0);
    assert.equal(result.session.cycle?.duration_seconds, 300);
    result = stopIrrigation(result.state, result.session, product, 'user_request', 7000);
    assert.equal(pump(result).runtime_seconds, 7);
    assert.equal(pump(result).stop_reason, 'user_request');
});

test('automatic watering uses fixed 50/5 hysteresis, cooldown and sensor interlocks', () => {
    let result = boot();
    result.state.instances.irrigation_automation.reported.control_mode = 'automatic';
    result.state.instances.main_garden.reported.moisture_level = 46;
    result = advanceIrrigation(result.state, result.session, product, 0);
    assert.equal(pump(result).pump_output_state, 'stopped');
    result.state.instances.main_garden.reported.moisture_level = 45;
    result = advanceIrrigation(result.state, result.session, product, 0);
    assert.equal(pump(result).pump_output_state, 'running');
    result.state.instances.main_garden.reported.moisture_level = 49;
    result = advanceIrrigation(result.state, result.session, product, 1000);
    assert.equal(pump(result).pump_output_state, 'running');
    result.state.instances.main_garden.reported.moisture_level = 50;
    result = advanceIrrigation(result.state, result.session, product, 2000);
    assert.equal(pump(result).pump_output_state, 'stopped');
    result.state.instances.main_garden.reported.moisture_level = 40;
    result = advanceIrrigation(result.state, result.session, product, 3000);
    assert.equal(pump(result).pump_output_state, 'stopped');
    result.state.instances.main_garden.reported.sensor_state = 'fault';
    result = advanceIrrigation(result.state, result.session, product, 62000);
    assert.equal(pump(result).pump_output_state, 'stopped');
    result.state.instances.main_garden.reported.sensor_state = 'ready';
    result = advanceIrrigation(result.state, result.session, product, 62000);
    assert.equal(pump(result).pump_output_state, 'running');
    result.state.instances.irrigation_automation.reported.control_mode = 'manual';
    result = advanceIrrigation(result.state, result.session, product, 63000);
    assert.equal(pump(result).pump_output_state, 'stopped');
});

test('restart safely stops a running pump and preserves a completed cooldown', () => {
    const initial = boot();
    const running = startIrrigation(initial.state, initial.session, product, 300, 'remote', 0);
    const recovered = initializeIrrigation(running.state, product, running.session, 5000)!;
    assert.equal(pump(recovered).pump_output_state, 'stopped');
    assert.equal(pump(recovered).stop_reason, 'controller_restart');
    assert.equal(recovered.session.cooldown_until, 65000);
    const restarted = initializeIrrigation(recovered.state, product, recovered.session, 6000)!;
    assert.equal(restarted.session.cooldown_until, 65000);
});

test('the live offline runtime enforces the physical pump deadline and rejects direct state bypass', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const initial = boot();
    const logger = { child: () => logger, info() {}, warn() {}, error() {}, debug() {} } as any;
    const transport = { isRelayAvailable: () => false, onBrokerUnavailable() {} } as any;
    const runtime = new DeviceRuntime('test-run', 'AA:00:00:00:00:01', product, 15000, 0, 0, 0, logger, transport, initial.state);
    const events: string[] = [];
    (runtime as any).persistRegistryState = async () => undefined;
    (runtime as any).emitDeviceEvent = async (event: any) => { events.push(event.event_name); };
    (runtime as any).updateRuntimeState = async () => undefined;
    t.after(async () => { await runtime.dispose(); t.mock.timers.reset(); });
    const started = await runtime.performPhysicalIrrigationAction('start');
    assert.equal(started.instances.irrigation_pump.reported.pump_output_state, 'running');
    await assert.rejects(runtime.patchState({ instances: { irrigation_pump: { reported: { runtime_seconds: 123 } } } }), /virtual firmware/);
    t.mock.timers.tick(300000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((runtime as any).state.instances.irrigation_pump.reported.pump_output_state, 'stopped');
    assert.equal((runtime as any).state.instances.irrigation_pump.reported.runtime_seconds, 300);
    assert.deepEqual(events, ['watering_started', 'watering_stopped']);
});
