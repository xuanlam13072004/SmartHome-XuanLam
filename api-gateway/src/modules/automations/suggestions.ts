import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { httpError } from '../../utils/httpError';
import { mayRun } from '../scenes/actions';
import type { SceneStepInput } from '../scenes/schemas';
import { insertScene, resolveSteps } from '../scenes/service';
import { findEvent, findProperty } from './catalog';
import type { AutomationInput } from './schemas';
import { homeLocation, weatherEnabled } from '../weather/service';
import {
    announceChange,
    getAutomation,
    inTransaction,
    insertAutomation,
    resolveAutomation,
} from './service';

/**
 * "Gợi ý": ready-made automations for devices the account already has, each
 * added with one tap (with the scene it runs, when it needs one). They only
 * join devices together or tell the user something the devices do not
 * already report: the roof closes for rain and the garden waters itself on
 * the devices, and warning/critical device events are notifications anyway.
 * A suggestion is identified by template and devices, and is offered until
 * an automation made from it exists. With a home location, two use the
 * forecast: water in the morning unless rain is coming, close the roof in
 * the evening when it is.
 */

const MAX_SUGGESTIONS = 8;
const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];

interface Device {
    id: string;
    mac: string;
    name: string;
    product_id: string;
    catalog_revision: number;
    role: string;
    granted_permissions: string[];
    product: any;
}

interface Plan {
    scene?: { name: string; icon: string; steps: SceneStepInput[] };
    automation: Omit<AutomationInput, 'scene_id' | 'timezone' | 'enabled'>;
}

interface Suggestion {
    key: string;
    template: string;
    title: string;
    description: string;
    plan: () => Plan;
}

const step = (mac: string, instanceId: string, operation: string): SceneStepInput => ({
    mac, instance_id: instanceId, operation, input: {}, delay_seconds: 0,
});

function can(app: FastifyInstance, device: Device, instanceId: string, operation: string): boolean {
    const definition = app.catalog.getOperation(device.product_id, instanceId, operation);
    return Boolean(definition && mayRun(device, definition));
}

const hasTrigger = (device: Device, path: string) => Boolean(findProperty(device.product, path, 'trigger'));
const hasCondition = (device: Device, path: string) => Boolean(findProperty(device.product, path, 'condition'));
const hasEvent = (device: Device, key: string) => Boolean(findEvent(device.product, key));
const hasCapability = (device: Device, capabilityId: string) =>
    (device.product.capability_instances ?? []).some((item: any) => item.capability_id === capabilityId);

function clip(text: string, max = 60): string {
    return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function templates(app: FastifyInstance, devices: Device[], weather: boolean): Suggestion[] {
    const result: Suggestion[] = [];
    if (weather) {
        const garden = devices.find(device => can(app, device, 'irrigation_pump', 'water_for_duration'));
        if (garden) {
            result.push({
                key: `weather_water:${garden.mac}`,
                template: 'weather_water',
                title: '6:00 tưới vườn nếu 12 giờ tới không mưa',
                description: `Mỗi sáng 6:00 tưới ${garden.name} 10 phút, bỏ qua khi dự báo có mưa.`,
                plan: () => ({
                    scene: {
                        name: clip(`Tưới ${garden.name} 10 phút`),
                        icon: 'water',
                        steps: [{ ...step(garden.mac, 'irrigation_pump', 'water_for_duration'), input: { duration_seconds: 600 } }],
                    },
                    automation: {
                        name: clip(`Tưới ${garden.name} nếu không mưa`),
                        trigger: { kind: 'time', time: '06:00', days: EVERY_DAY },
                        conditions: [{ weather: 'rain_next_12h', operator: 'eq', value: false }],
                        window: null, notify_message: null, cooldown_seconds: 300,
                    },
                }),
            });
        }
        const roof = devices.find(device => can(app, device, 'roof_motor', 'close'));
        if (roof) {
            result.push({
                key: `weather_roof:${roof.mac}`,
                template: 'weather_roof',
                title: '17:00 đóng mái nếu tối nay có mưa',
                description: `Mỗi chiều 17:00, nếu dự báo 6 giờ tới có mưa thì đóng ${roof.name} và báo cho bạn.`,
                plan: () => ({
                    scene: { name: clip(`Đóng ${roof.name}`), icon: 'rain', steps: [step(roof.mac, 'roof_motor', 'close')] },
                    automation: {
                        name: clip(`Đóng ${roof.name} trước mưa`),
                        trigger: { kind: 'time', time: '17:00', days: EVERY_DAY },
                        conditions: [{ weather: 'rain_next_6h', operator: 'eq', value: true }],
                        window: null,
                        notify_message: clip(`Tối nay có thể mưa nên ${roof.name} đã được đóng.`, 160),
                        cooldown_seconds: 300,
                    },
                }),
            });
        }
    }
    const roofs = devices.filter(device => can(app, device, 'roof_motor', 'open'));
    for (const hazard of devices.filter(device => hasEvent(device, 'hazard.incident_started'))) {
        const roof = roofs[0];
        if (!roof) break;
        result.push({
            key: `gas_vent:${hazard.mac}:${roof.mac}`,
            template: 'gas_vent',
            title: 'Có sự cố gas/cháy → mở mái thông gió',
            description: `Khi ${hazard.name} báo sự cố, mở ${roof.name} để thông gió.`,
            plan: () => ({
                scene: { name: 'Mở mái thông gió', icon: 'shield', steps: [step(roof.mac, 'roof_motor', 'open')] },
                automation: {
                    name: 'Sự cố gas/cháy → mở mái',
                    trigger: { kind: 'event', mac: hazard.mac, event: 'hazard.incident_started' },
                    conditions: [], window: null, notify_message: null, cooldown_seconds: 900,
                },
            }),
        });
    }
    for (const entrance of devices) {
        if (hasCondition(entrance, 'instances.main_lock.reported.lock_state') && can(app, entrance, 'main_lock', 'lock')) {
            result.push({
                key: `night_lock:${entrance.mac}`,
                template: 'night_lock',
                title: '23:00 tự khóa cửa nếu chưa khóa',
                description: `Mỗi tối 23:00, nếu ${entrance.name} chưa khóa thì khóa lại và báo cho bạn.`,
                plan: () => ({
                    scene: { name: clip(`Khóa ${entrance.name}`), icon: 'lock', steps: [step(entrance.mac, 'main_lock', 'lock')] },
                    automation: {
                        name: clip(`Tự khóa ${entrance.name} lúc 23:00`),
                        trigger: { kind: 'time', time: '23:00', days: EVERY_DAY },
                        conditions: [{
                            mac: entrance.mac,
                            property: 'instances.main_lock.reported.lock_state',
                            operator: 'ne',
                            value: 'locked',
                        }],
                        window: null,
                        notify_message: clip(`${entrance.name} chưa khóa lúc 23:00 nên đã được khóa lại.`, 160),
                        cooldown_seconds: 300,
                    },
                }),
            });
        }
        if (hasTrigger(entrance, 'instances.door_position.reported.door_state')) {
            result.push({
                key: `night_door:${entrance.mac}`,
                template: 'night_door',
                title: 'Cửa mở lúc đêm → báo cho bạn',
                description: `Báo khi ${entrance.name} mở trong khoảng 23:00–05:00.`,
                plan: () => ({
                    automation: {
                        name: clip(`${entrance.name} mở lúc đêm`),
                        trigger: {
                            kind: 'state', mac: entrance.mac,
                            property: 'instances.door_position.reported.door_state', operator: 'eq', value: 'open',
                        },
                        conditions: [],
                        window: { from: '23:00', to: '05:00' },
                        notify_message: clip(`${entrance.name} vừa mở lúc đêm.`, 160),
                        cooldown_seconds: 300,
                    },
                }),
            });
        }
    }
    const gardens = devices.filter(device => can(app, device, 'irrigation_pump', 'stop'));
    for (const rain of devices.filter(device => hasTrigger(device, 'instances.rain_sensor.reported.rain_detected'))) {
        const garden = gardens[0];
        if (!garden) break;
        result.push({
            key: `rain_stop:${rain.mac}:${garden.mac}`,
            template: 'rain_stop',
            title: 'Trời mưa → dừng tưới',
            description: `Khi ${rain.name} báo mưa, dừng tưới ở ${garden.name}.`,
            plan: () => ({
                scene: { name: 'Dừng tưới', icon: 'rain', steps: [step(garden.mac, 'irrigation_pump', 'stop')] },
                automation: {
                    name: 'Trời mưa → dừng tưới',
                    trigger: {
                        kind: 'state', mac: rain.mac,
                        property: 'instances.rain_sensor.reported.rain_detected', operator: 'eq', value: true,
                    },
                    conditions: [], window: null, notify_message: null, cooldown_seconds: 900,
                },
            }),
        });
    }
    for (const device of devices) {
        const important = hasCapability(device, 'hazard_controller') || hasCapability(device, 'camera_stream');
        if (!important || !hasTrigger(device, 'diagnostics.system.online')) continue;
        result.push({
            key: `offline:${device.mac}`,
            template: 'offline',
            title: `${device.name} mất kết nối → báo cho bạn`,
            description: 'Báo khi thiết bị ngừng kết nối với hệ thống, để bạn kiểm tra nguồn điện và Wi-Fi.',
            plan: () => ({
                automation: {
                    name: clip(`${device.name} mất kết nối`),
                    trigger: { kind: 'state', mac: device.mac, property: 'diagnostics.system.online', operator: 'eq', value: false },
                    conditions: [], window: null,
                    notify_message: clip(`${device.name} vừa mất kết nối.`, 160),
                    cooldown_seconds: 900,
                },
            }),
        });
    }
    return result;
}

async function candidates(app: FastifyInstance, accountId: string): Promise<{ list: Suggestion[]; added: Set<string> }> {
    const [devices, added, location] = await Promise.all([
        app.pg.query(
            `SELECT device.id, device.mac, device.name, device.product_id, device.catalog_revision, membership.role,
                    COALESCE(ARRAY_AGG(permission.permission_scope)
                        FILTER (WHERE permission.permission_scope IS NOT NULL),
                        ARRAY[]::text[]) AS granted_permissions
             FROM device_memberships AS membership
             JOIN device_metadata AS device ON device.id = membership.device_id AND device.is_active = true
             LEFT JOIN device_membership_permissions AS permission
               ON permission.device_id = membership.device_id AND permission.account_id = membership.account_id
             WHERE membership.account_id = $1 AND membership.status = 'active'
               AND (membership.expires_at IS NULL OR membership.expires_at > NOW())
             GROUP BY device.id, membership.role
             ORDER BY device.name, device.mac`,
            [accountId],
        ),
        app.pg.query('SELECT suggestion FROM automations WHERE account_id = $1 AND suggestion IS NOT NULL', [accountId]),
        weatherEnabled() ? homeLocation(app, accountId) : Promise.resolve(null),
    ]);
    const usable = devices.rows
        .map(row => ({ ...row, product: app.catalog.getProduct(row.product_id) }))
        .filter((device: any) => device.product && device.product.catalog_revision === device.catalog_revision);
    return {
        list: templates(app, usable as Device[], location !== null),
        added: new Set(added.rows.map(row => row.suggestion as string)),
    };
}

/** Suggestions not added yet, at most MAX_SUGGESTIONS. */
export async function listSuggestions(app: FastifyInstance, accountId: string) {
    const { list, added } = await candidates(app, accountId);
    return list
        .filter(suggestion => !added.has(suggestion.key))
        .slice(0, MAX_SUGGESTIONS)
        .map(({ key, template, title, description }) => ({ key, template, title, description }));
}

/** `base`, or `base 2`, `base 3`… when the account already uses the name. */
export async function freeName(client: PoolClient, table: 'scenes' | 'automations', accountId: string, base: string) {
    const taken = new Set((await client.query(
        `SELECT lower(btrim(name)) AS name FROM ${table} WHERE account_id = $1`,
        [accountId],
    )).rows.map(row => row.name as string));
    for (let index = 1; ; index += 1) {
        const suffix = index === 1 ? '' : ` ${index}`;
        const name = `${clip(base, 60 - suffix.length)}${suffix}`;
        if (!taken.has(name.toLowerCase())) return name;
    }
}

/** Adds the suggestion [key] (and the scene it runs) as an enabled automation. */
export async function applySuggestion(app: FastifyInstance, accountId: string, key: string, timezone: string) {
    const { list, added } = await candidates(app, accountId);
    if (added.has(key)) throw httpError(409, 'SUGGESTION_ALREADY_ADDED', 'This suggestion has already been added');
    const suggestion = list.find(item => item.key === key);
    if (!suggestion) throw httpError(404, 'SUGGESTION_NOT_FOUND', 'This suggestion is not available');
    const plan = suggestion.plan();
    const steps = plan.scene ? await resolveSteps(app, accountId, plan.scene.steps) : null;
    const resolved = await resolveAutomation(app, accountId, {
        ...plan.automation, scene_id: null, timezone, enabled: true,
    });
    const id = await inTransaction(app, async (client) => {
        const sceneId = plan.scene && steps
            ? await insertScene(client, accountId, {
                name: await freeName(client, 'scenes', accountId, plan.scene.name),
                icon: plan.scene.icon,
                steps,
            })
            : null;
        const name = await freeName(client, 'automations', accountId, plan.automation.name);
        return insertAutomation(app, client, accountId, {
            ...resolved,
            input: { ...resolved.input, name, scene_id: sceneId },
        }, { suggestion: key });
    });
    await announceChange(app, id);
    return { automation: await getAutomation(app, accountId, id), scene_created: Boolean(plan.scene) };
}
