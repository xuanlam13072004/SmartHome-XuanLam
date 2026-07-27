import type { CapabilityCommand } from '../catalog/loader';

export interface DeviceCommand {
    command_id: string;
    capability_id?: string;
    action: string;
    instance?: string;
    payload: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value);

const requireNonEmptyString = (
    value: unknown,
    field: string,
    maximumLength: number,
): string => {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`Command ${field} must be a non-empty string`);
    }
    if (value.length > maximumLength) {
        throw new Error(`Command ${field} exceeds ${maximumLength} characters`);
    }
    return value;
};

export const parseDeviceCommand = (input: unknown): DeviceCommand => {
    if (!isRecord(input)) throw new Error('Command must be a JSON object');

    const commandId = requireNonEmptyString(input.command_id, 'command_id', 200);
    const action = requireNonEmptyString(input.action, 'action', 100);
    const capabilityId = input.capability_id === undefined
        ? undefined
        : requireNonEmptyString(input.capability_id, 'capability_id', 100);
    const instance = input.instance === undefined
        ? undefined
        : requireNonEmptyString(input.instance, 'instance', 100);
    if (input.payload !== undefined && !isRecord(input.payload)) {
        throw new Error('Command payload must be a JSON object');
    }

    return {
        command_id: commandId,
        action,
        ...(capabilityId ? { capability_id: capabilityId } : {}),
        ...(instance ? { instance } : {}),
        payload: input.payload || {},
    };
};

export const validateCommandPayload = (
    command: CapabilityCommand,
    payload: Record<string, unknown>,
): void => {
    const argumentsByName = new Map(
        (command.arguments || []).map((argument) => [argument.name, argument]),
    );
    const unexpectedArguments = Object.keys(payload).filter(
        (name) => !argumentsByName.has(name),
    );
    if (unexpectedArguments.length > 0) {
        throw new Error(`Unexpected command argument ${unexpectedArguments.join(', ')}`);
    }

    for (const argument of command.arguments || []) {
        const hasValue = Object.prototype.hasOwnProperty.call(payload, argument.name);
        const required = argument.validation?.required !== false;
        if (!hasValue) {
            if (required) throw new Error(`Missing command argument ${argument.name}`);
            continue;
        }

        const value = payload[argument.name];
        const valueType = argument.value_type;
        if (valueType === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
            throw new Error(`Command argument ${argument.name} must be a finite number`);
        }
        if (valueType === 'boolean' && typeof value !== 'boolean') {
            throw new Error(`Command argument ${argument.name} must be a boolean`);
        }
        if (valueType === 'string' && typeof value !== 'string') {
            throw new Error(`Command argument ${argument.name} must be a string`);
        }

        const validation = argument.validation;
        if (
            typeof value === 'number'
            && validation?.min !== undefined
            && value < validation.min
        ) {
            throw new Error(`Command argument ${argument.name} must be at least ${validation.min}`);
        }
        if (
            typeof value === 'number'
            && validation?.max !== undefined
            && value > validation.max
        ) {
            throw new Error(`Command argument ${argument.name} must be at most ${validation.max}`);
        }
        if (
            typeof value === 'string'
            && validation?.max_length !== undefined
            && value.length > validation.max_length
        ) {
            throw new Error(
                `Command argument ${argument.name} exceeds ${validation.max_length} characters`,
            );
        }
        if (validation?.enum && !validation.enum.some((item) => Object.is(item, value))) {
            throw new Error(`Command argument ${argument.name} is not an allowed enum value`);
        }
    }
};
