import type { FastifyInstance } from 'fastify';
import { env } from '../../config/env';
import { automationProperties, shadowValue } from '../automations/catalog';
import { instanceLabel, isProtectedOperation, mayRun, operationLabel, sceneActionProblem } from '../scenes/actions';
import { listScenes } from '../scenes/service';

/**
 * What the assistant knows about the home for one turn: the devices the
 * account can see with their current state, the operations it may run
 * (the same rule as scene steps) and its scenes. The model sees short ids
 * (a1, s1); only the server maps them back, so it can never address
 * anything outside this list.
 */

type Schema = Record<string, any>;

export interface ActionInput {
    name: string;
    schema: Schema;
}

export interface AssistantAction {
    id: string;
    mac: string;
    device: string;
    instance_id: string;
    operation: string;
    label: string;
    /** 'confirm' (a tap) or 'reauthenticate' (the password) before it runs; null runs at once. */
    confirmation: 'confirm' | 'reauthenticate' | null;
    input: ActionInput | null;
}

export interface AssistantScene {
    id: string;
    scene_id: string;
    name: string;
    protected: boolean;
}

export interface HomeContext {
    actions: AssistantAction[];
    scenes: AssistantScene[];
    /** The JSON the model reads. */
    data: Record<string, unknown>;
}

export interface DeviceRow {
    mac: string;
    name: string;
    product_id: string;
    catalog_revision: number;
    role: string;
    room_id: string | null;
    granted_permissions: string[];
}

const UNITS: Record<string, string> = { second: 'giây', minute: 'phút', percent: '%', celsius: '°C' };

/**
 * The single value an operation takes, or null when it takes none. Operations
 * needing several values or structured ones (LCD lines) are not offered.
 */
export function singleInput(input: Record<string, Schema> | undefined): ActionInput | null | undefined {
    const entries = Object.entries(input ?? {});
    if (entries.length === 0) return null;
    if (entries.length > 1) return undefined;
    const [name, schema] = entries[0];
    const simple = schema.type === 'integer' || schema.type === 'number' || schema.type === 'boolean'
        || (schema.type === 'string' && Array.isArray(schema.enum));
    return simple ? { name, schema } : undefined;
}

function describeInput(schema: Schema) {
    return {
        type: schema.type === 'string' ? 'choice' : schema.type,
        ...(Array.isArray(schema.enum) ? { choices: schema.enum } : {}),
        ...(typeof schema.minimum === 'number' ? { min: schema.minimum } : {}),
        ...(typeof schema.maximum === 'number' ? { max: schema.maximum } : {}),
        ...(schema.unit ? { unit: UNITS[schema.unit] ?? schema.unit } : {}),
        ...(schema.default !== undefined ? { default: schema.default } : {}),
    };
}

function vietnamTime(now: Date): string {
    return new Intl.DateTimeFormat('vi-VN', {
        timeZone: 'Asia/Ho_Chi_Minh', weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
    }).format(now);
}

/** Pure: also used by the prompt evaluation script with a fixture home. */
export function buildHomeContext(input: {
    catalog: { getProduct(productId: string): unknown };
    devices: DeviceRow[];
    rooms: Map<string, string>;
    shadows: Map<string, any>;
    scenes: Array<{ id: string; name: string; protected: boolean }>;
    now?: Date;
}): HomeContext {
    const actions: AssistantAction[] = [];
    const devices = input.devices.map(device => {
        const product = input.catalog.getProduct(device.product_id) as any;
        const current = product && product.catalog_revision === device.catalog_revision;
        const shadow = input.shadows.get(device.mac);
        const state: Record<string, unknown> = {};
        if (current) {
            const seen = new Set<string>();
            for (const property of [...automationProperties(product, 'condition'), ...automationProperties(product, 'trigger')]) {
                if (seen.has(property.property) || property.property.startsWith('diagnostics.')) continue;
                seen.add(property.property);
                const value = shadowValue(shadow, property.property);
                if (value === undefined || value === null) continue;
                const label = property.instance_label === property.label
                    ? property.label : `${property.instance_label} · ${property.label}`;
                state[label] = property.unit ? `${value} ${UNITS[property.unit] ?? property.unit}` : value;
            }
        }
        const deviceActions = !current ? [] : Object.values(product.operations as Record<string, any>)
            .filter(operation => !sceneActionProblem(operation) && mayRun(device, operation))
            .flatMap(operation => {
                const parameter = singleInput(operation.input);
                if (parameter === undefined) return [];
                const action: AssistantAction = {
                    id: `a${actions.length + 1}`,
                    mac: device.mac,
                    device: device.name,
                    instance_id: operation.instance_id,
                    operation: operation.id,
                    label: operationLabel(operation, operation.id),
                    confirmation: isProtectedOperation(operation)
                        ? (operation.confirmation === 'reauthenticate' ? 'reauthenticate' : 'confirm') : null,
                    input: parameter,
                };
                actions.push(action);
                return [{
                    id: action.id,
                    do: `${instanceLabel(product, operation.instance_id)}: ${action.label}`,
                    ...(parameter ? { value: describeInput(parameter.schema) } : {}),
                    ...(action.confirmation ? { needs_confirmation: true } : {}),
                }];
            });
        return {
            name: device.name,
            room: device.room_id ? input.rooms.get(device.room_id) ?? null : null,
            online: shadow ? shadow.is_online === true : null,
            ...(Object.keys(state).length ? { state } : {}),
            ...(deviceActions.length ? { actions: deviceActions } : {}),
        };
    });
    const scenes = input.scenes.map((scene, index) => ({
        id: `s${index + 1}`, scene_id: scene.id, name: scene.name, protected: scene.protected,
    }));
    return {
        actions,
        scenes,
        data: {
            now: vietnamTime(input.now ?? new Date()),
            devices,
            scenes: scenes.map(scene => ({
                id: scene.id, name: scene.name, ...(scene.protected ? { needs_confirmation: true } : {}),
            })),
        },
    };
}

export async function loadHomeContext(app: FastifyInstance, accountId: string): Promise<HomeContext> {
    const [deviceResult, roomResult, scenes] = await Promise.all([
        app.pg.query(
            `SELECT device.mac, device.name, device.product_id, device.catalog_revision,
                    membership.role, membership.room_id,
                    COALESCE(ARRAY_AGG(permission.permission_scope)
                        FILTER (WHERE permission.permission_scope IS NOT NULL), ARRAY[]::text[]) AS granted_permissions
             FROM device_memberships AS membership
             JOIN device_metadata AS device ON device.id = membership.device_id AND device.is_active = true
             LEFT JOIN device_membership_permissions AS permission
               ON permission.device_id = membership.device_id AND permission.account_id = membership.account_id
             WHERE membership.account_id = $1 AND membership.status = 'active'
               AND (membership.expires_at IS NULL OR membership.expires_at > NOW())
             GROUP BY device.id, membership.role, membership.room_id
             ORDER BY device.name, device.mac
             LIMIT 100`,
            [accountId],
        ),
        app.pg.query('SELECT id, name FROM rooms WHERE account_id = $1', [accountId]),
        listScenes(app, accountId),
    ]);
    const devices = deviceResult.rows as DeviceRow[];
    const shadows = devices.length === 0 ? [] : await app.mongo.db
        .collection<any>(env.MONGO_DEVICE_SHADOWS_COLLECTION)
        .find({ _id: { $in: devices.map(device => device.mac) } }, { projection: { instances: 1, is_online: 1 } })
        .toArray();
    return buildHomeContext({
        catalog: app.catalog,
        devices,
        rooms: new Map(roomResult.rows.map(row => [row.id as string, row.name as string])),
        shadows: new Map(shadows.map(shadow => [String(shadow._id), shadow])),
        scenes: scenes.map(scene => ({ id: scene.id, name: scene.name, protected: scene.protected })),
    });
}
