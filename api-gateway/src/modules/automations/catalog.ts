import { instanceLabel } from '../scenes/actions';

/**
 * What an automation may watch, read from the catalog (one rule for the app's
 * pickers, validation on save and the engine):
 * - a trigger ("Khi") is a property with `automation.trigger`, or an event;
 * - a condition ("Nếu") is a property with `automation.condition`.
 * Only comparable properties qualify: booleans (is), strings with an enum
 * (is / is not) and numbers (above / below). Connectivity
 * (`diagnostics.<instance>.online`) comes from presence, not from telemetry.
 */

type Schema = Record<string, any>;

export type Operator = 'eq' | 'ne' | 'gt' | 'lt';
export type ValueKind = 'boolean' | 'enum' | 'number';
export type PropertyUse = 'trigger' | 'condition';

export interface AutomationProperty {
    property: string;
    instance_id: string;
    instance_label: string;
    label: string;
    kind: ValueKind;
    operators: Operator[];
    enum?: string[];
    unit?: string;
    minimum?: number;
    maximum?: number;
}

export interface AutomationEvent {
    event: string;
    instance_id: string;
    instance_label: string;
    capability_id: string;
    event_name: string;
    severity: string;
}

const OPERATORS: Record<ValueKind, Operator[]> = {
    boolean: ['eq'],
    enum: ['eq', 'ne'],
    number: ['gt', 'lt'],
};

const PRESENCE_PROPERTY = /^diagnostics\.[a-z][a-z0-9_]*\.online$/;

export function isPresenceProperty(path: string): boolean {
    return PRESENCE_PROPERTY.test(path);
}

function valueKind(schema: Schema): ValueKind | null {
    if (schema.type === 'boolean') return 'boolean';
    if (schema.type === 'string' && Array.isArray(schema.enum) && schema.enum.length > 0) return 'enum';
    if (schema.type === 'number' || schema.type === 'integer') return 'number';
    return null;
}

/** 'instances.<i>.reported.<p>' or 'diagnostics.<i>.<p>' → '<i>'. */
function instanceOf(path: string): string {
    return path.split('.')[1] ?? '';
}

function usable(schema: Schema | undefined, use: PropertyUse): schema is Schema {
    return Boolean(schema && schema.automation?.[use] === true
        && schema.presentation?.ui_hint !== 'hidden' && valueKind(schema));
}

/** Properties of [product] an automation may use as a trigger or a condition. */
export function automationProperties(product: any, use: PropertyUse): AutomationProperty[] {
    const result: AutomationProperty[] = [];
    for (const [path, schema] of Object.entries((product?.property_schemas ?? {}) as Record<string, Schema>)) {
        if (!usable(schema, use)) continue;
        const kind = valueKind(schema)!;
        const instanceId = instanceOf(path);
        result.push({
            property: path,
            instance_id: instanceId,
            instance_label: instanceLabel(product, instanceId),
            label: String(schema.presentation?.label || schema.id || path),
            kind,
            operators: OPERATORS[kind],
            ...(kind === 'enum' ? { enum: [...schema.enum] } : {}),
            ...(schema.unit ? { unit: String(schema.unit) } : {}),
            ...(typeof schema.minimum === 'number' ? { minimum: schema.minimum } : {}),
            ...(typeof schema.maximum === 'number' ? { maximum: schema.maximum } : {}),
        });
    }
    return result;
}

/** Events of [product], keyed '<instance>.<event>'. */
export function automationEvents(product: any): AutomationEvent[] {
    return Object.entries((product?.events ?? {}) as Record<string, Schema>).map(([key, event]) => ({
        event: key,
        instance_id: String(event.instance_id),
        instance_label: instanceLabel(product, String(event.instance_id)),
        capability_id: String(event.capability_id),
        event_name: String(event.id),
        severity: String(event.severity || 'info'),
    }));
}

export function findProperty(product: any, path: string, use: PropertyUse): AutomationProperty | null {
    return automationProperties(product, use).find(item => item.property === path) ?? null;
}

export function findEvent(product: any, key: string): AutomationEvent | null {
    return automationEvents(product).find(item => item.event === key) ?? null;
}

/** Whether `<property> <operator> <value>` is a comparison the property supports. */
export function validComparison(property: AutomationProperty, operator: Operator, value: unknown): boolean {
    if (!property.operators.includes(operator)) return false;
    switch (property.kind) {
        case 'boolean':
            return typeof value === 'boolean';
        case 'enum':
            return typeof value === 'string' && property.enum!.includes(value);
        case 'number':
            return typeof value === 'number' && Number.isFinite(value)
                && (property.minimum === undefined || value >= property.minimum)
                && (property.maximum === undefined || value <= property.maximum);
    }
}

/** A missing or null reading never satisfies a comparison. */
export function compare(actual: unknown, operator: Operator, expected: unknown): boolean {
    if (actual === undefined || actual === null) return false;
    switch (operator) {
        case 'eq': return actual === expected;
        case 'ne': return actual !== expected;
        case 'gt': return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
        case 'lt': return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
    }
}

/** Value at a dotted [path] of a state patch or shadow document; undefined when absent. */
export function readPath(source: unknown, path: string): unknown {
    let current: any = source;
    for (const part of path.split('.')) {
        if (current === null || typeof current !== 'object' || !(part in current)) return undefined;
        current = current[part];
    }
    return current;
}

/** Current value of [path] in a device shadow (connectivity from presence). */
export function shadowValue(shadow: any, path: string): unknown {
    if (!shadow) return undefined;
    return isPresenceProperty(path) ? shadow.is_online === true : readPath(shadow, path);
}
