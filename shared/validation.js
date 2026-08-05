'use strict';

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateValueAgainstSchema(value, schema, options = {}) {
    if (!isPlainObject(schema)) {
        return { valid: false, error: 'Schema is undefined or invalid' };
    }

    const required = options.required === true || schema.required === true;
    if (value === undefined) {
        return required
            ? { valid: false, error: 'Value is required' }
            : { valid: true, error: null };
    }
    if (value === null) {
        return schema.nullable === true
            ? { valid: true, error: null }
            : { valid: false, error: 'Value cannot be null' };
    }

    switch (schema.type) {
        case 'boolean':
            if (typeof value !== 'boolean') return { valid: false, error: 'Expected boolean' };
            break;
        case 'number':
            if (typeof value !== 'number' || !Number.isFinite(value)) {
                return { valid: false, error: 'Expected a finite number' };
            }
            break;
        case 'integer':
            if (!Number.isInteger(value)) return { valid: false, error: 'Expected integer' };
            break;
        case 'string':
            if (typeof value !== 'string') return { valid: false, error: 'Expected string' };
            if (schema.min_length !== undefined && value.length < schema.min_length) {
                return { valid: false, error: `String is shorter than ${schema.min_length}` };
            }
            if (schema.max_length !== undefined && value.length > schema.max_length) {
                return { valid: false, error: `String is longer than ${schema.max_length}` };
            }
            break;
        case 'array':
            if (!Array.isArray(value)) return { valid: false, error: 'Expected array' };
            if (schema.min_items !== undefined && value.length < schema.min_items) {
                return { valid: false, error: `Array has fewer than ${schema.min_items} items` };
            }
            if (schema.max_items !== undefined && value.length > schema.max_items) {
                return { valid: false, error: `Array has more than ${schema.max_items} items` };
            }
            if (schema.items) {
                for (let index = 0; index < value.length; index += 1) {
                    const itemResult = validateValueAgainstSchema(value[index], schema.items, { required: true });
                    if (!itemResult.valid) {
                        return { valid: false, error: `Item ${index}: ${itemResult.error}` };
                    }
                }
            }
            break;
        case 'object':
            if (!isPlainObject(value)) return { valid: false, error: 'Expected object' };
            if (isPlainObject(schema.properties)) {
                for (const [key, propertySchema] of Object.entries(schema.properties)) {
                    const propertyResult = validateValueAgainstSchema(
                        value[key],
                        propertySchema,
                        { required: propertySchema.required === true },
                    );
                    if (!propertyResult.valid) {
                        return { valid: false, error: `${key}: ${propertyResult.error}` };
                    }
                }
            }
            break;
        default:
            return { valid: false, error: `Unsupported schema type: ${schema.type}` };
    }

    if (typeof value === 'number') {
        if (schema.minimum !== undefined && value < schema.minimum) {
            return { valid: false, error: `Value is below minimum ${schema.minimum}` };
        }
        if (schema.maximum !== undefined && value > schema.maximum) {
            return { valid: false, error: `Value is above maximum ${schema.maximum}` };
        }
    }
    if (Array.isArray(schema.enum) && !schema.enum.some(candidate => Object.is(candidate, value))) {
        return { valid: false, error: 'Value is not in the allowed enum' };
    }

    return { valid: true, error: null };
}

function validateObjectAgainstSchema(input, schemaMap) {
    if (!isPlainObject(input)) return { valid: false, error: 'Input must be an object' };
    const unknown = Object.keys(input).filter(key => !Object.prototype.hasOwnProperty.call(schemaMap, key));
    if (unknown.length > 0) {
        return { valid: false, error: `Unknown input fields: ${unknown.join(', ')}` };
    }
    for (const [key, schema] of Object.entries(schemaMap)) {
        const result = validateValueAgainstSchema(input[key], schema, { required: true });
        if (!result.valid) return { valid: false, error: `${key}: ${result.error}` };
    }
    return { valid: true, error: null };
}

module.exports = {
    validateObjectAgainstSchema,
    validateValueAgainstSchema,
};
