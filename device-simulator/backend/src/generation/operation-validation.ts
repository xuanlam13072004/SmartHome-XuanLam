import type { CapabilityOperation, ValueSchema } from '../catalog/loader';
import type { OperationRoute } from '../runtime/topology';

export interface DeviceOperation {
    schema: 'device.operation.v2';
    operation_id: string;
    target_device_id: string;
    product_id: string;
    catalog_revision: number;
    instance_id: string;
    operation_name: string;
    input: Record<string, unknown>;
    context: Record<string, unknown>;
    issued_at: string;
    timeout_at: string;
    route: OperationRoute;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const requireString = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`Operation ${field} must be a non-empty string`);
    }
    return value.trim();
};

const parseRoute = (input: unknown): OperationRoute => {
    if (!isRecord(input)) throw new Error('Operation route must be an object');
    if (!['hub', 'relay', 'direct_fallback'].includes(String(input.mode))) {
        throw new Error('Operation route mode is invalid');
    }
    const epoch = Number(input.topology_epoch);
    if (!Number.isSafeInteger(epoch) || epoch < 0) {
        throw new Error('Operation route topology_epoch is invalid');
    }
    return {
        mode: input.mode as OperationRoute['mode'],
        network_id: requireString(input.network_id, 'route.network_id'),
        topology_epoch: epoch,
        hub_mac: input.hub_mac === null
            ? null
            : requireString(input.hub_mac, 'route.hub_mac').toUpperCase(),
    };
};

export const parseDeviceOperation = (input: unknown): DeviceOperation => {
    if (!isRecord(input) || input.schema !== 'device.operation.v2') {
        throw new Error('Operation contract is invalid');
    }
    if (!isRecord(input.input)) throw new Error('Operation input must be an object');
    if (input.context !== undefined && !isRecord(input.context)) {
        throw new Error('Operation context must be an object');
    }
    const revision = Number(input.catalog_revision);
    if (!Number.isSafeInteger(revision) || revision < 1) {
        throw new Error('Operation catalog_revision is invalid');
    }
    const operation: DeviceOperation = {
        schema: 'device.operation.v2',
        operation_id: requireString(input.operation_id, 'operation_id'),
        target_device_id: requireString(input.target_device_id, 'target_device_id').toUpperCase(),
        product_id: requireString(input.product_id, 'product_id'),
        catalog_revision: revision,
        instance_id: requireString(input.instance_id, 'instance_id'),
        operation_name: requireString(input.operation_name, 'operation_name'),
        input: input.input,
        context: isRecord(input.context) ? input.context : {},
        issued_at: requireString(input.issued_at, 'issued_at'),
        timeout_at: requireString(input.timeout_at, 'timeout_at'),
        route: parseRoute(input.route),
    };
    if (new Date(operation.timeout_at).getTime() <= Date.now()) {
        throw new Error('Operation expired before execution');
    }
    return operation;
};

export function validateValueAgainstSchema(
    value: unknown,
    schema: ValueSchema,
    field: string,
): void {
    if (value === null) {
        if (schema.nullable) return;
        throw new Error(`${field} cannot be null`);
    }
    if (schema.type === 'boolean' && typeof value !== 'boolean') {
        throw new Error(`${field} must be boolean`);
    }
    if (schema.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
        throw new Error(`${field} must be a finite number`);
    }
    if (schema.type === 'integer' && !Number.isInteger(value)) {
        throw new Error(`${field} must be an integer`);
    }
    if (schema.type === 'string' && typeof value !== 'string') {
        throw new Error(`${field} must be a string`);
    }
    if (schema.type === 'array' && !Array.isArray(value)) {
        throw new Error(`${field} must be an array`);
    }
    if (typeof value === 'number') {
        if (schema.minimum !== undefined && value < schema.minimum) {
            throw new Error(`${field} must be at least ${schema.minimum}`);
        }
        if (schema.maximum !== undefined && value > schema.maximum) {
            throw new Error(`${field} must be at most ${schema.maximum}`);
        }
    }
    if (typeof value === 'string') {
        if (schema.min_length !== undefined && value.length < schema.min_length) {
            throw new Error(`${field} is too short`);
        }
        if (schema.max_length !== undefined && value.length > schema.max_length) {
            throw new Error(`${field} is too long`);
        }
    }
    if (Array.isArray(value)) {
        if (schema.min_items !== undefined && value.length < schema.min_items) {
            throw new Error(`${field} contains too few items`);
        }
        if (schema.max_items !== undefined && value.length > schema.max_items) {
            throw new Error(`${field} contains too many items`);
        }
        if (schema.items) value.forEach((item, index) => (
            validateValueAgainstSchema(item, schema.items!, `${field}[${index}]`)
        ));
    }
    if (schema.enum && !schema.enum.some(candidate => Object.is(candidate, value))) {
        throw new Error(`${field} is not an allowed value`);
    }
}

export const validateOperationInput = (
    operation: CapabilityOperation,
    input: Record<string, unknown>,
): void => {
    const unknown = Object.keys(input).filter(key => !(key in (operation.input || {})));
    if (unknown.length > 0) throw new Error(`Unexpected operation input: ${unknown.join(', ')}`);
    for (const [name, schema] of Object.entries(operation.input || {})) {
        if (!Object.prototype.hasOwnProperty.call(input, name)) {
            throw new Error(`Missing operation input ${name}`);
        }
        validateValueAgainstSchema(input[name], schema, name);
    }
};
