import type { ProductCatalog } from '../catalog/loader';
import type { DeviceState } from '../generation/telemetry-generator';

export const ENTRANCE_SERVO_TRANSITION_MS = 500;
export const ENTRANCE_UNLOCK_WAIT_MS = 30_000;
export const ENTRANCE_CLOSED_RELOCK_MS = 3_000;
export const ENTRANCE_PIN_LOCKOUT_MS = 30_000;
export const ENTRANCE_DOOR_OPEN_DEGREES = 12;
export const ENTRANCE_DOOR_CLOSED_DEGREES = 4;

export type EntranceTimerKind =
    | 'servo_unlock'
    | 'unlock_wait'
    | 'closed_relock'
    | 'servo_lock'
    | 'pin_lockout';

export type EntrancePhase =
    | 'idle'
    | 'pin_entry'
    | 'unlocking'
    | 'unlocked_wait_open'
    | 'door_open'
    | 'closed_wait_relock'
    | 'locking'
    | 'sensor_fault'
    | 'pin_locked_out';

export interface EntranceSession {
    phase: EntrancePhase;
    pin_buffer: string;
    attempts_remaining: number;
    lockout_until?: string;
    custom_lcd_lines?: string[];
    pending_lock_reason?: string;
    actuator_source?: 'keypad' | 'face' | 'remote' | 'automatic' | 'boot_recovery' | 'unknown';
    door_opened_since_unlock?: boolean;
}

export interface DeviceEventDraft {
    instance_id: string;
    event_name: string;
    data: Record<string, unknown>;
}

export interface EntranceTransition {
    state: DeviceState;
    session: EntranceSession;
    events: DeviceEventDraft[];
    cancel_timer: boolean;
    timer?: { kind: EntranceTimerKind; delay_ms: number };
}

interface EntranceInstances {
    lock: string;
    position: string;
    pin: string;
    keypad: string;
    lcd: string;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const lcdLine = (value: string): string => value.slice(0, 20);

const instancesFor = (product: ProductCatalog): EntranceInstances | null => {
    const find = (capabilityId: string) => product.capability_instances
        .find((instance) => instance.capability_id === capabilityId)?.instance_id;
    const result = {
        lock: find('door_lock'),
        position: find('door_position'),
        pin: find('pin_authentication'),
        keypad: find('keypad_input'),
        lcd: find('character_display_4x20'),
    };
    return Object.values(result).every(Boolean) ? result as EntranceInstances : null;
};

export const canOpenEntranceDoor = (
    current: DeviceState,
    product: ProductCatalog,
): boolean => {
    const instances = instancesFor(product);
    return Boolean(
        instances
        && value(current, instances.lock, 'lock_state') === 'unlocked',
    );
};

export const assertVirtualDoorPositionAllowed = (
    current: DeviceState,
    product: ProductCatalog,
    angleDegrees: number,
    sensorState: 'calibrating' | 'ready' | 'fault',
): void => {
    if (
        sensorState === 'ready'
        && angleDegrees > ENTRANCE_DOOR_CLOSED_DEGREES
        && !canOpenEntranceDoor(current, product)
    ) {
        throw new Error('Enter the correct PIN and wait until the door is unlocked before opening it');
    }
};

const reported = (
    state: DeviceState,
    instanceId: string,
): Record<string, unknown> => {
    state.instances[instanceId] ||= { reported: {}, desired: {} };
    return state.instances[instanceId].reported;
};

const value = (state: DeviceState, instanceId: string, property: string): unknown =>
    state.instances[instanceId]?.reported?.[property];

const setDisplay = (
    state: DeviceState,
    instanceId: string,
    source: 'firmware' | 'authentication' | 'safety' | 'custom',
    lines: string[],
): void => {
    const target = reported(state, instanceId);
    target.display_source = source;
    target.displayed_lines = Array.from(
        { length: 4 },
        (_, index) => lcdLine(String(lines[index] || '')),
    );
};

const captureCustomDisplay = (
    state: DeviceState,
    session: EntranceSession,
    lcdInstance: string,
): EntranceSession => {
    if (value(state, lcdInstance, 'display_source') !== 'custom') return session;
    const lines = value(state, lcdInstance, 'displayed_lines');
    return {
        ...session,
        custom_lcd_lines: Array.isArray(lines)
            ? Array.from({ length: 4 }, (_, index) => lcdLine(String(lines[index] || '')))
            : undefined,
    };
};

const showIdle = (
    state: DeviceState,
    session: EntranceSession,
    lcdInstance: string,
): void => {
    if (session.custom_lcd_lines) {
        setDisplay(state, lcdInstance, 'custom', session.custom_lcd_lines);
        return;
    }
    setDisplay(state, lcdInstance, 'firmware', [
        'Xin chao!',
        'Cua dang khoa',
        'Nhan A de mo khoa',
        '',
    ]);
};

const transition = (
    state: DeviceState,
    session: EntranceSession,
    events: DeviceEventDraft[] = [],
    timer?: EntranceTransition['timer'],
): EntranceTransition => {
    state.state_version += 1;
    return { state, session, events, cancel_timer: true, ...(timer ? { timer } : {}) };
};

export const initializeEntranceController = (
    current: DeviceState,
    product: ProductCatalog,
    pinConfigured: boolean,
): EntranceTransition | null => {
    const instances = instancesFor(product);
    if (!instances) return null;
    const state = clone(current);
    let session: EntranceSession = {
        phase: 'idle',
        pin_buffer: '',
        attempts_remaining: 3,
        door_opened_since_unlock: false,
    };
    session = captureCustomDisplay(state, session, instances.lcd);
    reported(state, instances.pin).pin_configured = pinConfigured;
    const position = reported(state, instances.position);
    position.door_angle_degrees = typeof position.door_angle_degrees === 'number'
        ? Math.min(180, Math.max(0, position.door_angle_degrees))
        : 0;
    position.position_sensor_state ||= 'ready';
    position.door_state ||= 'closed';
    // Reconcile snapshots produced before physical door angles were excluded
    // from random telemetry evolution. A closed virtual door always starts at
    // its calibrated 0-degree position.
    if (position.door_state === 'closed') position.door_angle_degrees = 0;

    const sensorReady = position.position_sensor_state === 'ready';
    const doorClosed = position.door_state === 'closed';
    const safeToLock = sensorReady && doorClosed;
    const previousLockState = String(value(current, instances.lock, 'lock_state') || 'locked');
    // Mirror the firmware's stable NVS recovery: an interrupted unlock still
    // has "locked" persisted, while an interrupted lock still has "unlocked".
    const preferredUnlocked = previousLockState === 'unlocked'
        || previousLockState === 'locking'
        || previousLockState === 'fault';

    if (safeToLock && preferredUnlocked) {
        reported(state, instances.lock).lock_state = 'unlocked';
        session = {
            ...session,
            phase: 'unlocked_wait_open',
            actuator_source: 'boot_recovery',
        };
        setDisplay(state, instances.lcd, 'authentication', [
            'DA MO KHOA',
            'Mo cua trong 30 giay',
            'Se tu dong khoa',
            '',
        ]);
        return transition(state, session, [], {
            kind: 'unlock_wait',
            delay_ms: ENTRANCE_UNLOCK_WAIT_MS,
        });
    }
    if (safeToLock) {
        reported(state, instances.lock).lock_state = 'locked';
        showIdle(state, session, instances.lcd);
        return transition(state, session);
    }

    reported(state, instances.lock).lock_state = 'unlocked';
    session = {
        ...session,
        phase: sensorReady ? 'door_open' : 'sensor_fault',
        actuator_source: 'boot_recovery',
        door_opened_since_unlock: sensorReady,
    };
    if (sensorReady) {
        setDisplay(state, instances.lcd, 'firmware', [
            'CUA DANG MO',
            'Khoa dang mo',
            'Dong cua de tu khoa',
            '',
        ]);
    } else if (position.position_sensor_state === 'calibrating') {
        setDisplay(state, instances.lcd, 'safety', [
            'CAN HIEU CHUAN CUA',
            'Dong cua hoan toan',
            'Nhan D de xac nhan',
            '',
        ]);
    } else {
        setDisplay(state, instances.lcd, 'safety', [
            'LOI CAM BIEN CUA',
            'Khong tu dong khoa',
            'Kiem tra MPU6050',
            '',
        ]);
    }
    return transition(state, session);
};

export const handleEntranceKey = (
    current: DeviceState,
    currentSession: EntranceSession,
    product: ProductCatalog,
    accessPin: string,
    keyInput: string,
    now = new Date(),
): EntranceTransition => {
    const instances = instancesFor(product);
    if (!instances) throw new Error('This Product has no entrance-controller hardware');
    const key = keyInput.trim().toUpperCase();
    if (!/^[0-9A-D*#]$/.test(key)) throw new Error('Unsupported 4x4 keypad key');
    const state = clone(current);
    let session = captureCustomDisplay(state, clone(currentSession), instances.lcd);
    const events: DeviceEventDraft[] = [];

    const lockoutUntil = session.lockout_until
        ? Date.parse(session.lockout_until)
        : 0;
    if (lockoutUntil > now.getTime()) {
        throw new Error('Keypad is temporarily locked');
    }
    if (session.lockout_until) {
        session = {
            ...session,
            phase: session.phase === 'pin_locked_out' ? 'idle' : session.phase,
            attempts_remaining: 3,
            lockout_until: undefined,
        };
        if (session.phase === 'idle') showIdle(state, session, instances.lcd);
    }

    if (
        key === 'D'
        && value(state, instances.position, 'position_sensor_state') === 'calibrating'
    ) {
        const position = reported(state, instances.position);
        const previousDoorState = String(position.door_state || 'unknown');
        position.door_angle_degrees = 0;
        position.position_sensor_state = 'ready';
        position.door_state = 'closed';
        if (previousDoorState !== 'closed') {
            events.push({
                instance_id: instances.position,
                event_name: 'door_closed',
                data: { angle_degrees: 0 },
            });
        }

        const lockState = String(value(state, instances.lock, 'lock_state') || 'fault');
        const servoTransition = session.phase === 'unlocking' || session.phase === 'locking';
        if (servoTransition) {
            const next = transition(state, session, events);
            next.cancel_timer = false;
            return next;
        }
        if (lockState === 'unlocked') {
            session = {
                ...session,
                phase: 'closed_wait_relock',
                door_opened_since_unlock: true,
            };
            setDisplay(state, instances.lcd, 'safety', [
                'DA HIEU CHUAN CUA',
                'Tu khoa sau 3 giay',
                'Vui long doi...',
                '',
            ]);
            return transition(state, session, events, {
                kind: 'closed_relock',
                delay_ms: ENTRANCE_CLOSED_RELOCK_MS,
            });
        }
        session = { ...session, phase: 'idle', door_opened_since_unlock: false };
        showIdle(state, session, instances.lcd);
        return transition(state, session, events);
    }

    if (session.phase === 'idle') {
        // Unassigned physical keys are ignored just like the real keypad
        // firmware; only A starts authentication from the idle screen.
        if (key !== 'A') return { state, session, events, cancel_timer: false };
        if (value(state, instances.lock, 'lock_state') !== 'locked') {
            throw new Error('The lock is not in its idle locked state');
        }
        session = { ...session, phase: 'pin_entry', pin_buffer: '' };
        setDisplay(state, instances.lcd, 'authentication', [
            'NHAP MA PIN',
            '',
            '*: Xoa',
            '#: Xac nhan',
        ]);
        events.push({
            instance_id: instances.keypad,
            event_name: 'keypad_action',
            data: { action: 'authentication_requested' },
        });
        return transition(state, session, events);
    }

    if (session.phase !== 'pin_entry') {
        throw new Error('Keypad input is unavailable in the current door-lock state');
    }

    if (/^[0-9]$/.test(key)) {
        if (session.pin_buffer.length < 6) session.pin_buffer += key;
        setDisplay(state, instances.lcd, 'authentication', [
            'NHAP MA PIN',
            '*'.repeat(session.pin_buffer.length),
            '*: Xoa',
            '#: Xac nhan',
        ]);
        return transition(state, session);
    }
    if (key === '*') {
        if (session.pin_buffer.length > 0) {
            session.pin_buffer = session.pin_buffer.slice(0, -1);
            setDisplay(state, instances.lcd, 'authentication', [
                'NHAP MA PIN',
                '*'.repeat(session.pin_buffer.length),
                '*: Xoa',
                '#: Xac nhan',
            ]);
        } else {
            events.push({
                instance_id: instances.keypad,
                event_name: 'keypad_action',
                data: { action: 'authentication_cancelled' },
            });
            session = { ...session, phase: 'idle', pin_buffer: '' };
            showIdle(state, session, instances.lcd);
        }
        return transition(state, session, events);
    }
    if (key !== '#') return { state, session, events, cancel_timer: false };
    if (session.pin_buffer.length !== 6) throw new Error('The access PIN must contain exactly 6 digits');

    events.push({
        instance_id: instances.keypad,
        event_name: 'keypad_action',
        data: { action: 'authentication_submitted' },
    });
    if (session.pin_buffer === accessPin) {
        reported(state, instances.lock).lock_state = 'unlocking';
        session = {
            ...session,
            phase: 'unlocking',
            pin_buffer: '',
            attempts_remaining: 3,
            pending_lock_reason: undefined,
            actuator_source: 'keypad',
            door_opened_since_unlock: false,
        };
        setDisplay(state, instances.lcd, 'authentication', [
            'MA PIN CHINH XAC',
            'DANG MO KHOA...',
            '',
            '',
        ]);
        events.push(
            {
                instance_id: instances.pin,
                event_name: 'pin_access_granted',
                data: { credential_id: 'primary' },
            },
            {
                instance_id: instances.lock,
                event_name: 'lock_changed',
                data: { state: 'unlocking', source: 'keypad', reason: 'pin_verified' },
            },
        );
        return transition(state, session, events, {
            kind: 'servo_unlock',
            delay_ms: ENTRANCE_SERVO_TRANSITION_MS,
        });
    }

    const attemptsRemaining = Math.max(0, session.attempts_remaining - 1);
    events.push({
        instance_id: instances.pin,
        event_name: 'pin_access_denied',
        data: { attempts_remaining: attemptsRemaining },
    });
    if (attemptsRemaining === 0) {
        const lockedUntil = new Date(now.getTime() + ENTRANCE_PIN_LOCKOUT_MS).toISOString();
        session = {
            ...session,
            phase: 'pin_locked_out',
            pin_buffer: '',
            attempts_remaining: 0,
            lockout_until: lockedUntil,
        };
        setDisplay(state, instances.lcd, 'safety', [
            'BAN PHIM TAM KHOA',
            'Sai ma qua nhieu lan',
            'Thu lai sau 30 giay',
            '',
        ]);
        events.push({
            instance_id: instances.pin,
            event_name: 'pin_locked_out',
            data: { lockout_seconds: ENTRANCE_PIN_LOCKOUT_MS / 1000 },
        });
        return transition(state, session, events, {
            kind: 'pin_lockout',
            delay_ms: ENTRANCE_PIN_LOCKOUT_MS,
        });
    }
    session = {
        ...session,
        pin_buffer: '',
        attempts_remaining: attemptsRemaining,
    };
    setDisplay(state, instances.lcd, 'authentication', [
        'MA PIN KHONG DUNG',
        `Con ${attemptsRemaining} lan thu`,
        'Nhap lai ma PIN',
        '#: Xac nhan',
    ]);
    return transition(state, session, events);
};

export const handleEntranceTimer = (
    current: DeviceState,
    currentSession: EntranceSession,
    product: ProductCatalog,
    kind: EntranceTimerKind,
): EntranceTransition => {
    const instances = instancesFor(product);
    if (!instances) throw new Error('This Product has no entrance-controller hardware');
    const state = clone(current);
    let session = clone(currentSession);
    const events: DeviceEventDraft[] = [];
    const doorState = String(value(state, instances.position, 'door_state') || 'unknown');
    const sensorState = String(value(state, instances.position, 'position_sensor_state') || 'fault');

    if (kind === 'pin_lockout' && session.phase === 'pin_locked_out') {
        session = {
            ...session,
            phase: 'idle',
            pin_buffer: '',
            attempts_remaining: 3,
            lockout_until: undefined,
        };
        showIdle(state, session, instances.lcd);
        return transition(state, session);
    }
    if (kind === 'servo_unlock' && session.phase === 'unlocking') {
        reported(state, instances.lock).lock_state = 'unlocked';
        const sensorReady = sensorState === 'ready';
        const doorAlreadyMoved = sensorReady && doorState !== 'closed';
        session = {
            ...session,
            phase: !sensorReady
                ? 'sensor_fault'
                : doorAlreadyMoved
                    ? 'door_open'
                    : 'unlocked_wait_open',
            door_opened_since_unlock: doorAlreadyMoved || session.door_opened_since_unlock,
        };
        if (!sensorReady) {
            setDisplay(state, instances.lcd, 'safety', [
                'LOI CAM BIEN CUA',
                'Khoa da mo an toan',
                'Khong tu dong khoa',
                '',
            ]);
        } else if (doorAlreadyMoved) {
            setDisplay(state, instances.lcd, 'firmware', [
                'CUA DANG MO',
                'Khoa dang mo',
                'Dong cua de tu khoa',
                '',
            ]);
        } else {
            setDisplay(state, instances.lcd, 'authentication', [
                'DA MO KHOA',
                'Mo cua trong 30 giay',
                'Se tu dong khoa',
                '',
            ]);
        }
        events.push({
            instance_id: instances.lock,
            event_name: 'lock_changed',
            data: {
                state: 'unlocked',
                source: session.actuator_source || 'unknown',
                reason: 'servo_completed',
            },
        });
        return transition(
            state,
            session,
            events,
            !sensorReady || doorAlreadyMoved
                ? undefined
                : { kind: 'unlock_wait', delay_ms: ENTRANCE_UNLOCK_WAIT_MS },
        );
    }
    if (
        (kind === 'unlock_wait' && session.phase === 'unlocked_wait_open')
        || (kind === 'closed_relock' && session.phase === 'closed_wait_relock')
    ) {
        if (doorState !== 'closed' || sensorState !== 'ready') {
            return { state, session, events, cancel_timer: true };
        }
        const reason = kind === 'unlock_wait'
            ? 'door_not_opened_30s'
            : 'door_closed_stable_3s';
        reported(state, instances.lock).lock_state = 'locking';
        session = {
            ...session,
            phase: 'locking',
            pending_lock_reason: reason,
            actuator_source: 'automatic',
        };
        setDisplay(state, instances.lcd, 'authentication', [
            'DANG KHOA CUA...',
            '',
            '',
            '',
        ]);
        events.push({
            instance_id: instances.lock,
            event_name: 'lock_changed',
            data: { state: 'locking', source: 'automatic', reason },
        });
        return transition(state, session, events, {
            kind: 'servo_lock',
            delay_ms: ENTRANCE_SERVO_TRANSITION_MS,
        });
    }
    if (kind === 'servo_lock' && session.phase === 'locking') {
        if (doorState !== 'closed' || sensorState !== 'ready') {
            reported(state, instances.lock).lock_state = 'unlocked';
            session = { ...session, phase: 'sensor_fault' };
            setDisplay(state, instances.lcd, 'safety', [
                'KHONG THE KHOA CUA',
                'Cua chua dong an toan',
                '',
                '',
            ]);
            return transition(state, session);
        }
        const reason = session.pending_lock_reason || 'automatic_relock';
        const source = session.actuator_source || 'unknown';
        reported(state, instances.lock).lock_state = 'locked';
        session = {
            ...session,
            phase: 'idle',
            pin_buffer: '',
            pending_lock_reason: undefined,
            actuator_source: undefined,
            door_opened_since_unlock: false,
        };
        showIdle(state, session, instances.lcd);
        events.push({
            instance_id: instances.lock,
            event_name: 'lock_changed',
            data: {
                state: 'locked',
                source,
                reason,
            },
        });
        return transition(state, session, events);
    }
    return { state, session, events, cancel_timer: false };
};

export const setEntranceDoorPosition = (
    current: DeviceState,
    currentSession: EntranceSession,
    product: ProductCatalog,
    angleInput: number,
    sensorStateInput: 'calibrating' | 'ready' | 'fault' = 'ready',
): EntranceTransition => {
    const instances = instancesFor(product);
    if (!instances) throw new Error('This Product has no entrance-controller hardware');
    if (!Number.isFinite(angleInput) || angleInput < 0 || angleInput > 180) {
        throw new Error('Door angle must be between 0 and 180 degrees');
    }
    const state = clone(current);
    let session = captureCustomDisplay(state, clone(currentSession), instances.lcd);
    const events: DeviceEventDraft[] = [];
    const position = reported(state, instances.position);
    const previousAngle = typeof position.door_angle_degrees === 'number'
        ? position.door_angle_degrees
        : 0;
    const previousDoorState = String(position.door_state || 'unknown');
    position.door_angle_degrees = Math.round(angleInput * 10) / 10;
    position.position_sensor_state = sensorStateInput;
    const isServoTransition = session.phase === 'unlocking' || session.phase === 'locking';

    if (sensorStateInput !== 'ready') {
        position.door_state = 'unknown';
        session = {
            ...session,
            phase: ['unlocking', 'locking'].includes(session.phase)
                ? session.phase
                : 'sensor_fault',
        };
        setDisplay(state, instances.lcd, 'safety', [
            'LOI CAM BIEN CUA',
            'Khong tu dong khoa',
            'Kiem tra MPU6050',
            '',
        ]);
        if (previousDoorState !== 'unknown') {
            events.push({
                instance_id: instances.position,
                event_name: 'door_position_fault',
                data: { reason: `mpu6050_${sensorStateInput}` },
            });
        }
        const next = transition(state, session, events);
        if (isServoTransition) next.cancel_timer = false;
        return next;
    }

    let doorState: string;
    if (angleInput <= ENTRANCE_DOOR_CLOSED_DEGREES) doorState = 'closed';
    else if (angleInput >= ENTRANCE_DOOR_OPEN_DEGREES) doorState = 'open';
    else if (angleInput > previousAngle) doorState = 'opening';
    else if (angleInput < previousAngle) doorState = 'closing';
    else doorState = ['opening', 'closing'].includes(previousDoorState)
        ? previousDoorState
        : 'unknown';
    position.door_state = doorState;

    const lockState = String(value(state, instances.lock, 'lock_state') || 'fault');
    if (doorState !== 'closed' && (lockState === 'unlocked' || lockState === 'unlocking')) {
        session = { ...session, door_opened_since_unlock: true };
    }

    if (doorState === 'open') {
        session = {
            ...session,
            phase: isServoTransition ? session.phase : 'door_open',
        };
        setDisplay(state, instances.lcd, 'firmware', [
            'CUA DANG MO',
            'Khoa dang mo',
            'Dong cua de tu khoa',
            '',
        ]);
        if (previousDoorState !== 'open') {
            events.push({
                instance_id: instances.position,
                event_name: 'door_opened',
                data: { angle_degrees: position.door_angle_degrees },
            });
            if (value(state, instances.lock, 'lock_state') === 'locked') {
                events.push({
                    instance_id: instances.position,
                    event_name: 'door_position_fault',
                    data: { reason: 'door_moved_while_locked' },
                });
            }
        }
        const next = transition(state, session, events);
        if (isServoTransition) next.cancel_timer = false;
        return next;
    }

    if (doorState === 'closed' && previousDoorState !== 'closed') {
        events.push({
            instance_id: instances.position,
            event_name: 'door_closed',
            data: { angle_degrees: position.door_angle_degrees },
        });
    }
    if (
        doorState === 'closed'
        && lockState === 'unlocked'
        && (session.door_opened_since_unlock || session.phase === 'sensor_fault')
        && session.phase !== 'closed_wait_relock'
    ) {
        session = {
            ...session,
            phase: 'closed_wait_relock',
            door_opened_since_unlock: true,
        };
        setDisplay(state, instances.lcd, 'authentication', [
            'CUA DA DONG',
            'Tu khoa sau 3 giay',
            'Vui long doi...',
            '',
        ]);
        return transition(state, session, events, {
            kind: 'closed_relock',
            delay_ms: ENTRANCE_CLOSED_RELOCK_MS,
        });
    }
    if (doorState === 'closed' && lockState === 'locked' && session.phase !== 'locking') {
        session = { ...session, phase: 'idle' };
        showIdle(state, session, instances.lcd);
    } else if (doorState === 'opening' && !isServoTransition) {
        session = { ...session, phase: 'door_open' };
    }
    const preserveActiveTimer = isServoTransition
        || (doorState === 'closed' && [
            'unlocked_wait_open',
            'closed_wait_relock',
        ].includes(session.phase));
    const next = transition(state, session, events);
    if (preserveActiveTimer) next.cancel_timer = false;
    return next;
};

export const beginRemoteLockOperation = (
    current: DeviceState,
    currentSession: EntranceSession,
    product: ProductCatalog,
    operationName: 'lock' | 'unlock',
): EntranceTransition => {
    const instances = instancesFor(product);
    if (!instances) throw new Error('This Product has no entrance-controller hardware');
    const state = clone(current);
    let session = captureCustomDisplay(state, clone(currentSession), instances.lcd);
    const doorState = value(state, instances.position, 'door_state');
    const sensorState = value(state, instances.position, 'position_sensor_state');
    const currentLockState = value(state, instances.lock, 'lock_state');

    if (operationName === 'lock') {
        if (doorState !== 'closed' || sensorState !== 'ready') {
            throw new Error('Cannot lock until the door is confirmed closed');
        }
        if (currentLockState === 'locked') {
            if (session.phase === 'idle') {
                return { state, session, events: [], cancel_timer: false };
            }
            session = {
                ...session,
                phase: 'idle',
                pin_buffer: '',
                pending_lock_reason: undefined,
                actuator_source: undefined,
                door_opened_since_unlock: false,
            };
            showIdle(state, session, instances.lcd);
            return transition(state, session);
        }
        reported(state, instances.lock).lock_state = 'locking';
        session = {
            ...session,
            phase: 'locking',
            pending_lock_reason: 'remote_command',
            actuator_source: 'remote',
            door_opened_since_unlock: false,
        };
        setDisplay(state, instances.lcd, 'authentication', ['DANG KHOA CUA...', '', '', '']);
        return transition(state, session, [{
            instance_id: instances.lock,
            event_name: 'lock_changed',
            data: { state: 'locking', source: 'remote', reason: 'remote_command' },
        }], { kind: 'servo_lock', delay_ms: ENTRANCE_SERVO_TRANSITION_MS });
    }

    if (currentLockState === 'unlocked') {
        return { state, session, events: [], cancel_timer: false };
    }
    reported(state, instances.lock).lock_state = 'unlocking';
    session = {
        ...session,
        phase: 'unlocking',
        pending_lock_reason: undefined,
        actuator_source: 'remote',
        door_opened_since_unlock: false,
    };
    setDisplay(state, instances.lcd, 'authentication', ['DANG MO KHOA...', '', '', '']);
    return transition(state, session, [{
        instance_id: instances.lock,
        event_name: 'lock_changed',
        data: { state: 'unlocking', source: 'remote', reason: 'remote_command' },
    }], { kind: 'servo_unlock', delay_ms: ENTRANCE_SERVO_TRANSITION_MS });
};
