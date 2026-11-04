import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProductCatalog } from '../src/catalog/loader';
import {
    evolveState,
    generateInitialState,
    type DeviceState,
} from '../src/generation/telemetry-generator';
import {
    assertVirtualDoorPositionAllowed,
    beginRemoteLockOperation,
    canOpenEntranceDoor,
    handleEntranceKey,
    handleEntranceTimer,
    initializeEntranceController,
    setEntranceDoorPosition,
    type DeviceEventDraft,
    type EntranceSession,
    type EntranceTransition,
} from '../src/runtime/entrance-controller';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { compileCatalog, loadCatalogV2 } = require('../../../shared/catalog-v2');

const product = compileCatalog(loadCatalogV2())
    .product_index.prod_entrance_controller as ProductCatalog;
const ACCESS_PIN = '012345';

const boot = (): EntranceTransition => {
    const initialized = initializeEntranceController(
        generateInitialState(product),
        product,
        true,
    );
    assert.ok(initialized);
    return initialized;
};

const press = (
    state: DeviceState,
    session: EntranceSession,
    key: string,
    now = new Date('2026-08-14T00:00:00.000Z'),
) => handleEntranceKey(state, session, product, ACCESS_PIN, key, now);

const enterPin = (
    current: EntranceTransition,
    pin = ACCESS_PIN,
): { transition: EntranceTransition; events: DeviceEventDraft[] } => {
    let transition = press(current.state, current.session, 'A');
    const events = [...transition.events];
    for (const digit of pin) {
        transition = press(transition.state, transition.session, digit);
        events.push(...transition.events);
    }
    transition = press(transition.state, transition.session, '#');
    events.push(...transition.events);
    return { transition, events };
};

test('entrance boots locked with the exact firmware LCD contract', () => {
    const initialized = boot();
    assert.equal(initialized.state.instances.main_lock.reported.lock_state, 'locked');
    assert.equal(initialized.state.instances.door_position.reported.door_state, 'closed');
    assert.equal(initialized.state.instances.door_position.reported.door_angle_degrees, 0);
    assert.deepEqual(initialized.state.instances.lcd.reported.displayed_lines, [
        'Xin chao!',
        'Cua dang khoa',
        'Nhan A de mo khoa',
        '',
    ]);
    assert.equal(initialized.session.phase, 'idle');
});

test('periodic telemetry never invents MPU6050 door movement', () => {
    const initialized = boot();
    const originalRandom = Math.random;
    Math.random = () => 1;
    try {
        let evolved = initialized.state;
        for (let cycle = 0; cycle < 100; cycle += 1) {
            evolved = evolveState(evolved, product);
        }
        assert.equal(evolved.instances.door_position.reported.door_angle_degrees, 0);
        assert.equal(evolved.instances.door_position.reported.door_state, 'closed');
    } finally {
        Math.random = originalRandom;
    }
});

test('legacy closed snapshots are reconciled to the calibrated zero-degree angle', () => {
    const persisted = generateInitialState(product);
    persisted.instances.door_position.reported.door_state = 'closed';
    persisted.instances.door_position.reported.door_angle_degrees = 21.6;

    const restored = initializeEntranceController(persisted, product, true);

    assert.ok(restored);
    assert.equal(restored.state.instances.door_position.reported.door_state, 'closed');
    assert.equal(restored.state.instances.door_position.reported.door_angle_degrees, 0);
});

test('virtual door opening is enabled only after PIN unlock has completed', () => {
    const initialized = boot();
    assert.equal(canOpenEntranceDoor(initialized.state, product), false);
    assert.throws(
        () => assertVirtualDoorPositionAllowed(initialized.state, product, 90, 'ready'),
        /correct PIN/,
    );
    assert.doesNotThrow(
        () => assertVirtualDoorPositionAllowed(initialized.state, product, 0, 'ready'),
    );

    const unlocking = enterPin(initialized).transition;
    assert.equal(canOpenEntranceDoor(unlocking.state, product), false);

    const unlocked = handleEntranceTimer(
        unlocking.state,
        unlocking.session,
        product,
        'servo_unlock',
    );
    assert.equal(canOpenEntranceDoor(unlocked.state, product), true);
    assert.doesNotThrow(
        () => assertVirtualDoorPositionAllowed(unlocked.state, product, 90, 'ready'),
    );
});

test('restart restores a stable unlocked door and restarts the unopened timeout', () => {
    const persisted = generateInitialState(product);
    persisted.instances.main_lock.reported.lock_state = 'unlocked';
    const restored = initializeEntranceController(persisted, product, true);

    assert.ok(restored);
    assert.equal(restored.state.instances.main_lock.reported.lock_state, 'unlocked');
    assert.equal(restored.session.phase, 'unlocked_wait_open');
    assert.equal(restored.timer?.kind, 'unlock_wait');
    assert.equal(restored.timer?.delay_ms, 30_000);
});

test('restart with a healthy open door is not mislabeled as a sensor fault', () => {
    const persisted = generateInitialState(product);
    persisted.instances.door_position.reported.door_angle_degrees = 90;
    persisted.instances.door_position.reported.door_state = 'open';
    persisted.instances.door_position.reported.position_sensor_state = 'ready';
    const restored = initializeEntranceController(persisted, product, true);

    assert.ok(restored);
    assert.equal(restored.state.instances.main_lock.reported.lock_state, 'unlocked');
    assert.equal(restored.session.phase, 'door_open');
    assert.equal(restored.state.instances.lcd.reported.display_source, 'firmware');
    assert.match(restored.state.instances.lcd.reported.displayed_lines.join(' '), /CUA DANG MO/);
});

test('correct PIN unlocks locally, emits sanitized events and relocks after 30 seconds', () => {
    const entered = enterPin(boot());
    assert.equal(entered.transition.state.instances.main_lock.reported.lock_state, 'unlocking');
    assert.equal(entered.transition.timer?.kind, 'servo_unlock');
    assert.equal(JSON.stringify(entered.events).includes(ACCESS_PIN), false);
    assert.equal(JSON.stringify(entered.events).includes('pin_buffer'), false);

    const unlocked = handleEntranceTimer(
        entered.transition.state,
        entered.transition.session,
        product,
        'servo_unlock',
    );
    assert.equal(unlocked.state.instances.main_lock.reported.lock_state, 'unlocked');
    assert.equal(unlocked.session.phase, 'unlocked_wait_open');
    assert.equal(unlocked.events[0]?.data.source, 'keypad');
    assert.equal(unlocked.timer?.kind, 'unlock_wait');

    const locking = handleEntranceTimer(
        unlocked.state,
        unlocked.session,
        product,
        'unlock_wait',
    );
    assert.equal(locking.state.instances.main_lock.reported.lock_state, 'locking');
    assert.equal(locking.timer?.kind, 'servo_lock');

    const locked = handleEntranceTimer(
        locking.state,
        locking.session,
        product,
        'servo_lock',
    );
    assert.equal(locked.state.instances.main_lock.reported.lock_state, 'locked');
    assert.equal(locked.session.phase, 'idle');
});

test('opening then closing the physical door waits three seconds before relocking', () => {
    const entered = enterPin(boot()).transition;
    const unlocked = handleEntranceTimer(
        entered.state,
        entered.session,
        product,
        'servo_unlock',
    );
    const opened = setEntranceDoorPosition(
        unlocked.state,
        unlocked.session,
        product,
        90,
        'ready',
    );
    assert.equal(opened.state.instances.door_position.reported.door_state, 'open');
    assert.equal(opened.session.phase, 'door_open');
    assert.equal(opened.events.some((event) => event.event_name === 'door_opened'), true);

    const closed = setEntranceDoorPosition(
        opened.state,
        opened.session,
        product,
        0,
        'ready',
    );
    assert.equal(closed.state.instances.door_position.reported.door_state, 'closed');
    assert.equal(closed.state.instances.main_lock.reported.lock_state, 'unlocked');
    assert.equal(closed.timer?.kind, 'closed_relock');
    assert.equal(closed.timer?.delay_ms, 3_000);

    const repeatedClosedSample = setEntranceDoorPosition(
        closed.state,
        closed.session,
        product,
        0,
        'ready',
    );
    assert.equal(repeatedClosedSample.timer, undefined);
    assert.equal(repeatedClosedSample.cancel_timer, false);
    assert.equal(repeatedClosedSample.session.phase, 'closed_wait_relock');

    const locking = handleEntranceTimer(
        closed.state,
        closed.session,
        product,
        'closed_relock',
    );
    assert.equal(locking.state.instances.main_lock.reported.lock_state, 'locking');
});

test('closed MPU samples do not replace the 30-second unopened-door timer', () => {
    const entered = enterPin(boot()).transition;
    const unlocked = handleEntranceTimer(
        entered.state,
        entered.session,
        product,
        'servo_unlock',
    );
    const closedSample = setEntranceDoorPosition(
        unlocked.state,
        unlocked.session,
        product,
        0,
        'ready',
    );
    assert.equal(closedSample.session.phase, 'unlocked_wait_open');
    assert.equal(closedSample.timer, undefined);
    assert.equal(closedSample.cancel_timer, false);
});

test('MPU updates cannot cancel a servo transition and an early-open door skips the 30-second timer', () => {
    const entered = enterPin(boot()).transition;
    const movedDuringServo = setEntranceDoorPosition(
        entered.state,
        entered.session,
        product,
        45,
        'ready',
    );
    assert.equal(movedDuringServo.session.phase, 'unlocking');
    assert.equal(movedDuringServo.cancel_timer, false);

    const completed = handleEntranceTimer(
        movedDuringServo.state,
        movedDuringServo.session,
        product,
        'servo_unlock',
    );
    assert.equal(completed.session.phase, 'door_open');
    assert.equal(completed.timer, undefined);
});

test('an MPU fault during servo unlock keeps the controller safe and disables auto-lock', () => {
    const entered = enterPin(boot()).transition;
    const faultDuringServo = setEntranceDoorPosition(
        entered.state,
        entered.session,
        product,
        0,
        'fault',
    );
    assert.equal(faultDuringServo.session.phase, 'unlocking');
    assert.equal(faultDuringServo.cancel_timer, false);

    const completed = handleEntranceTimer(
        faultDuringServo.state,
        faultDuringServo.session,
        product,
        'servo_unlock',
    );
    assert.equal(completed.state.instances.main_lock.reported.lock_state, 'unlocked');
    assert.equal(completed.session.phase, 'sensor_fault');
    assert.equal(completed.timer, undefined);
    assert.equal(completed.state.instances.lcd.reported.display_source, 'safety');
    assert.match(
        completed.state.instances.lcd.reported.displayed_lines.join(' '),
        /LOI CAM BIEN CUA/,
    );
});

test('key D completes virtual MPU calibration and uses the safe closed debounce', () => {
    const entered = enterPin(boot()).transition;
    const unlocked = handleEntranceTimer(
        entered.state,
        entered.session,
        product,
        'servo_unlock',
    );
    const calibrating = setEntranceDoorPosition(
        unlocked.state,
        unlocked.session,
        product,
        0,
        'calibrating',
    );
    const calibrated = press(calibrating.state, calibrating.session, 'D');

    assert.equal(
        calibrated.state.instances.door_position.reported.position_sensor_state,
        'ready',
    );
    assert.equal(calibrated.state.instances.door_position.reported.door_state, 'closed');
    assert.equal(calibrated.session.phase, 'closed_wait_relock');
    assert.equal(calibrated.timer?.kind, 'closed_relock');
    assert.equal(calibrated.timer?.delay_ms, 3_000);
});

test('sensor fault and an open door both prevent locking', () => {
    const entered = enterPin(boot()).transition;
    const unlocked = handleEntranceTimer(
        entered.state,
        entered.session,
        product,
        'servo_unlock',
    );
    const fault = setEntranceDoorPosition(
        unlocked.state,
        unlocked.session,
        product,
        0,
        'fault',
    );
    assert.equal(fault.session.phase, 'sensor_fault');
    assert.throws(
        () => beginRemoteLockOperation(fault.state, fault.session, product, 'lock'),
        /confirmed closed/,
    );

    const open = setEntranceDoorPosition(
        unlocked.state,
        unlocked.session,
        product,
        45,
        'ready',
    );
    assert.throws(
        () => beginRemoteLockOperation(open.state, open.session, product, 'lock'),
        /confirmed closed/,
    );
});

test('three invalid PIN submissions lock the keypad without exposing the attempted PIN', () => {
    let current = boot();
    const allEvents: DeviceEventDraft[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const entered = enterPin(current, '999999');
        current = entered.transition;
        allEvents.push(...entered.events);
    }
    assert.equal(current.session.phase, 'pin_locked_out');
    assert.equal(current.session.attempts_remaining, 0);
    assert.equal(current.timer?.kind, 'pin_lockout');
    assert.equal(allEvents.some((event) => event.event_name === 'pin_locked_out'), true);
    assert.deepEqual(
        allEvents.find((event) => event.event_name === 'pin_locked_out')?.data,
        { lockout_seconds: 30 },
    );
    assert.equal(JSON.stringify(allEvents).includes('999999'), false);
});

test('remote unlock remains attributed to remote through servo completion', () => {
    const initialized = boot();
    const unlocking = beginRemoteLockOperation(
        initialized.state,
        initialized.session,
        product,
        'unlock',
    );
    const unlocked = handleEntranceTimer(
        unlocking.state,
        unlocking.session,
        product,
        'servo_unlock',
    );
    assert.equal(unlocked.events[0]?.data.source, 'remote');
});
