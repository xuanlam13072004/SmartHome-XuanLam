import assert from 'node:assert/strict';
import test from 'node:test';
import type { CapabilityCommand, ProductCatalog } from '../src/catalog/loader';
import {
    parseDeviceCommand,
    validateCommandPayload,
} from '../src/generation/command-validation';
import { applyCommandToState } from '../src/generation/telemetry-generator';

const numericCommand: CapabilityCommand = {
    action: 'SET_BRIGHTNESS',
    arguments: [{
        name: 'brightness',
        value_type: 'number',
        validation: { min: 0, max: 100 },
    }],
};

test('command parser accepts a valid object and normalizes an omitted payload', () => {
    assert.deepEqual(
        parseDeviceCommand({ command_id: 'cmd-1', action: 'LOCK' }),
        { command_id: 'cmd-1', action: 'LOCK', payload: {} },
    );
});

test('command parser rejects invalid root fields and non-object payloads', () => {
    assert.throws(() => parseDeviceCommand(null), /JSON object/);
    assert.throws(
        () => parseDeviceCommand({ command_id: 'cmd-1', action: 'LOCK', payload: [] }),
        /payload must be a JSON object/,
    );
});

test('no-argument commands reject unexpected payload fields', () => {
    assert.doesNotThrow(() => validateCommandPayload(
        { action: 'LOCK', arguments: [] },
        {},
    ));
    assert.throws(
        () => validateCommandPayload(
            { action: 'LOCK', arguments: [] },
            { value: true },
        ),
        /Unexpected command argument value/,
    );
});

test('numeric command arguments enforce type and min/max', () => {
    assert.doesNotThrow(() => validateCommandPayload(numericCommand, { brightness: 75 }));
    assert.throws(
        () => validateCommandPayload(numericCommand, { brightness: '75' }),
        /finite number/,
    );
    assert.throws(
        () => validateCommandPayload(numericCommand, { brightness: 101 }),
        /at most 100/,
    );
});

test('enum, string length and optional multi-arguments are validated', () => {
    const command: CapabilityCommand = {
        action: 'SET_PROFILE',
        arguments: [
            {
                name: 'mode',
                value_type: 'string',
                validation: { enum: ['eco', 'comfort'], max_length: 10 },
            },
            {
                name: 'label',
                value_type: 'string',
                validation: { required: false, max_length: 5 },
            },
        ],
    };
    assert.doesNotThrow(() => validateCommandPayload(command, { mode: 'eco' }));
    assert.doesNotThrow(() => validateCommandPayload(
        command,
        { mode: 'comfort', label: 'night' },
    ));
    assert.throws(
        () => validateCommandPayload(command, { mode: 'turbo' }),
        /allowed enum/,
    );
    assert.throws(
        () => validateCommandPayload(command, { mode: 'eco', label: 'too-long' }),
        /exceeds 5 characters/,
    );
});

test('validated multi-argument command mutates only its catalog state keys', () => {
    const product: ProductCatalog = {
        id: 'product-test',
        display_name: 'Test light',
        category: 'light',
        capabilities: [],
        default_state: {},
        capabilityInstances: [{
            capability_id: 'light.color',
            instance: 'main',
            state_properties: {
                hue: { value_type: 'number', validation: { min: 0, max: 360 } },
                saturation: { value_type: 'number', validation: { min: 0, max: 100 } },
            },
            diagnostic_properties: {},
            commands: [{
                action: 'SET_COLOR',
                arguments: [
                    {
                        name: 'hue',
                        value_type: 'number',
                        validation: { min: 0, max: 360 },
                    },
                    {
                        name: 'saturation',
                        value_type: 'number',
                        validation: { min: 0, max: 100 },
                    },
                ],
            }],
        }],
    };

    const next = applyCommandToState(
        { metrics: { hue: 0, saturation: 0 }, diagnostics: {} },
        product,
        {
            capability_id: 'light.color',
            instance: 'main',
            action: 'SET_COLOR',
            payload: { hue: 240, saturation: 80 },
        },
    );
    assert.deepEqual(next.metrics, { hue: 240, saturation: 80 });
});
