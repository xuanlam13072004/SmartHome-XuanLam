import type { FastifyInstance } from 'fastify';
import { env } from '../../config/env';
import { type AutomationProperty, automationEvents, automationProperties, type Operator, shadowValue } from '../automations/catalog';
import { eventLabel, stateName, valueLabel } from '../automations/labels';
import { NOTIFICATION_SEVERITIES } from '../../../../shared/notification-categories';
import { chartMeasures, type ChartMeasure } from '../device/stats';
import { instanceLabel, isProtectedOperation, mayRun, operationLabel, sceneActionProblem } from '../scenes/actions';
import { listScenes } from '../scenes/service';
import { HISTORY_DAYS, isoDay, UNIT_LABELS } from './history';
import { TEMPERATURE_RANGE, WEATHER_CONDITIONS } from '../weather/forecast';
import { homeLocation, weatherEnabled } from '../weather/service';

/**
 * What the assistant knows about the home for one turn: the devices the
 * account can see with their current state, the operations it may run
 * (the same rule as scene steps), what an automation may watch on them
 * (states and events, the same rule as the automation pickers) and its
 * scenes, and what its history may be looked up for (history.ts). The model
 * sees short ids (a1, w1, e1, s1, d1, v1, m1, u1); only the server maps them
 * back, so it can never address anything outside this list.
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

/** A state an automation may watch ("Khi" and/or "Nếu"). */
export interface AssistantWatch extends AutomationProperty {
    id: string;
    mac: string;
    device: string;
    trigger: boolean;
    condition: boolean;
    /** A weather condition at home ("Nếu" only): its id; mac is empty then. */
    weather?: string;
}

/** An event an automation may start on. */
export interface AssistantEvent {
    id: string;
    mac: string;
    device: string;
    /** '<instance>.<event>', as automations store it. */
    event: string;
    event_name: string;
    label: string;
}

export interface AssistantScene {
    id: string;
    scene_id: string;
    name: string;
    protected: boolean;
}

/** An automation of the account, for "did it run?" (look_up_history what = runs). */
export interface AssistantAutomation {
    id: string;
    automation_id: string;
    name: string;
    /** Its steps run as a scene; without one it only notifies. */
    has_scene: boolean;
}

/** An event the person may look up in a device's history. */
export interface HistoryEvent {
    id: string;
    instance_id: string;
    event_name: string;
    label: string;
}

/** A sampled reading (temperature, gas level…) whose history may be looked up. */
export interface HistoryReading extends ChartMeasure {
    id: string;
}

/**
 * A device whose history may be looked up, with what the person may see:
 * the owner every event; a member (shared device) the warnings and alerts
 * only, from the day they joined, like the notification center and charts.
 */
export interface HistoryDevice {
    id: string;
    mac: string;
    device: string;
    owner: boolean;
    /** PostgreSQL id, current owner and since when the person has the device (null in pure tests). */
    device_id: string | null;
    owner_id: string | null;
    joined_at: Date | null;
    product_id: string;
    events: HistoryEvent[];
    readings: HistoryReading[];
}

/** A plan the account can buy in the chat (the server prices it again when the order is created). */
export interface PurchasablePlan {
    code: string;
    name: string;
    prices: Array<{ months: 1 | 12; amount_vnd: number }>;
}

export interface HomeContext {
    actions: AssistantAction[];
    watches: AssistantWatch[];
    events: AssistantEvent[];
    scenes: AssistantScene[];
    /** Plans offer_plan may propose; empty when payments are off. */
    plans: PurchasablePlan[];
    automations: AssistantAutomation[];
    history: HistoryDevice[];
    /** When this context was built (periods like "hôm qua" are counted from it). */
    now: Date;
    /** The JSON the model reads. */
    data: Record<string, unknown>;
    /**
     * What automations may watch, per device; added to [data] only for
     * messages that may be about automations (planner.ts), to keep ordinary
     * turns small.
     */
    automationData: Array<Record<string, unknown>>;
    /** What history may be looked up, added to [data] only for questions that may be about the past. */
    historyData: Record<string, unknown>;
}

export interface DeviceRow {
    mac: string;
    name: string;
    product_id: string;
    catalog_revision: number;
    role: string;
    room_id: string | null;
    granted_permissions: string[];
    device_id?: string;
    owner_id?: string;
    joined_at?: Date | string;
}

const UNITS = UNIT_LABELS;

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

/**
 * States worth offering: connectivity but not other diagnostics (signal,
 * firmware, uptime), and no unbounded counters (bytes, seconds running).
 */
function worthWatching(property: AutomationProperty): boolean {
    if (property.property.startsWith('diagnostics.')) return property.property.endsWith('.online');
    return property.kind !== 'number' || property.maximum !== undefined;
}

/** How the model sees a watchable state: allowed values (with their words) or a range. */
function describeWatch(watch: AssistantWatch) {
    const name = stateName(watch.property);
    const use = watch.trigger && watch.condition ? undefined : watch.trigger ? 'khi' : 'nếu';
    const values = watch.kind === 'boolean'
        ? { true: valueLabel(name, true), false: valueLabel(name, false) }
        : watch.kind === 'enum'
            ? Object.fromEntries(watch.enum!.map(value => [value, valueLabel(name, value)]))
            : undefined;
    return {
        id: watch.id,
        what: watch.instance_label === watch.label ? watch.label : `${watch.instance_label} · ${watch.label}`,
        ...(values ? { values } : {
            number: [watch.minimum ?? null, watch.maximum ?? null],
            ...(watch.unit ? { unit: UNITS[watch.unit] ?? watch.unit } : {}),
        }),
        ...(use ? { only: use } : {}),
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
    automations?: Array<{ id: string; name: string; scene_id: string | null }>;
    /**
     * The home location's name (weather conditions and look_up_weather); null:
     * no home location yet; left out: weather is off on this server.
     */
    weather?: { place: string } | null;
    now?: Date;
}): HomeContext {
    const now = input.now ?? new Date();
    const actions: AssistantAction[] = [];
    const watches: AssistantWatch[] = [];
    const events: AssistantEvent[] = [];
    const history: HistoryDevice[] = [];
    let historyEvents = 0;
    let historyReadings = 0;
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
        const deviceWatches: AssistantWatch[] = [];
        if (current) {
            const triggers = automationProperties(product, 'trigger');
            const conditions = automationProperties(product, 'condition');
            for (const property of [...triggers, ...conditions]) {
                if (!worthWatching(property) || deviceWatches.some(item => item.property === property.property)) continue;
                const watch: AssistantWatch = {
                    ...property,
                    id: `w${watches.length + 1}`,
                    mac: device.mac,
                    device: device.name,
                    trigger: triggers.some(item => item.property === property.property),
                    condition: conditions.some(item => item.property === property.property),
                };
                watches.push(watch);
                deviceWatches.push(watch);
            }
        }
        const deviceEvents = !current ? [] : automationEvents(product).map(item => {
            const event: AssistantEvent = {
                id: `e${events.length + 1}`,
                mac: device.mac,
                device: device.name,
                event: item.event,
                event_name: item.event_name,
                label: eventLabel(item.event_name),
            };
            events.push(event);
            return { id: event.id, what: event.label };
        });
        const owner = device.role === 'owner';
        const room = device.room_id ? input.rooms.get(device.room_id) ?? null : null;
        if (product) {
            const visible = automationEvents(product)
                .filter(item => owner || (NOTIFICATION_SEVERITIES as readonly string[]).includes(item.severity));
            const names = visible.map(item => item.event_name);
            const entry: HistoryDevice = {
                id: `d${history.length + 1}`,
                mac: device.mac,
                device: device.name,
                owner,
                device_id: device.device_id ?? null,
                owner_id: device.owner_id ?? null,
                joined_at: device.joined_at ? new Date(device.joined_at) : null,
                product_id: device.product_id,
                events: visible.map(item => ({
                    id: `v${(historyEvents += 1)}`,
                    instance_id: item.instance_id,
                    event_name: item.event_name,
                    // Two instances reporting the same event are told apart by their names.
                    label: names.filter(name => name === item.event_name).length > 1
                        ? `${item.instance_label} · ${eventLabel(item.event_name)}` : eventLabel(item.event_name),
                })),
                readings: chartMeasures(product)
                    .filter(measure => !measure.property.startsWith('diagnostics.'))
                    .map(measure => ({ ...measure, id: `m${(historyReadings += 1)}` })),
            };
            history.push(entry);
        }
        return {
            name: device.name,
            room,
            online: shadow ? shadow.is_online === true : null,
            ...(Object.keys(state).length ? { state } : {}),
            ...(deviceActions.length ? { actions: deviceActions } : {}),
            automation: {
                device: device.name,
                ...(deviceWatches.length ? { watch: deviceWatches.map(describeWatch) } : {}),
                ...(deviceEvents.length ? { events: deviceEvents } : {}),
            },
        };
    });
    const automationData: Array<Record<string, unknown>> = devices
        .map(device => device.automation)
        .filter(item => item.watch !== undefined || item.events !== undefined);
    // The weather at home can be a condition ("Nếu"), like a device state.
    if (input.weather) {
        const weatherWatches: AssistantWatch[] = WEATHER_CONDITIONS.map((condition, index) => ({
            id: `w${watches.length + index + 1}`,
            mac: '',
            device: 'Thời tiết',
            weather: condition.id,
            property: `weather.${condition.id}`,
            instance_id: 'weather',
            instance_label: 'Thời tiết',
            label: condition.label,
            kind: condition.kind,
            operators: (condition.kind === 'boolean' ? ['eq'] : ['gt', 'lt']) as Operator[],
            ...(condition.kind === 'number' ? { unit: 'celsius', ...TEMPERATURE_RANGE } : {}),
            trigger: false,
            condition: true,
        }));
        watches.push(...weatherWatches);
        automationData.push({ device: `Thời tiết ở ${input.weather.place}`, watch: weatherWatches.map(describeWatch) });
    }
    const scenes = input.scenes.map((scene, index) => ({
        id: `s${index + 1}`, scene_id: scene.id, name: scene.name, protected: scene.protected,
    }));
    const automations = (input.automations ?? []).map((automation, index) => ({
        id: `u${index + 1}`, automation_id: automation.id, name: automation.name, has_scene: automation.scene_id !== null,
    }));
    const historyData = {
        today: isoDay(now.getTime()),
        kept_days: HISTORY_DAYS,
        devices: history.map(item => {
            const room = input.devices.find(device => device.mac === item.mac)?.room_id;
            return {
                id: item.id,
                device: item.device,
                ...(room && input.rooms.get(room) ? { room: input.rooms.get(room) } : {}),
                ...(item.owner ? {} : { sees: 'alerts_only' }),
                ...(item.events.length ? { events: item.events.map(event => ({ id: event.id, what: event.label })) } : {}),
                ...(item.readings.length ? {
                    readings: item.readings.map(reading => ({
                        id: reading.id,
                        what: reading.instance_label === reading.label ? reading.label : `${reading.instance_label} · ${reading.label}`,
                        ...(reading.unit ? { unit: UNITS[reading.unit] ?? reading.unit } : {}),
                    })),
                } : {}),
            };
        }),
        ...(automations.length ? { automations: automations.map(item => ({ id: item.id, name: item.name })) } : {}),
    };
    return {
        actions,
        watches,
        events,
        scenes,
        plans: [],
        automations,
        history,
        now,
        automationData,
        historyData,
        data: {
            now: vietnamTime(now),
            // Where the forecast is for (look_up_weather); null: no home location yet; absent: weather off.
            ...(input.weather === undefined ? {} : { weather: input.weather ? { place: input.weather.place } : null }),
            devices: devices.map(({ automation: _, ...device }) => device),
            scenes: scenes.map(scene => ({
                id: scene.id, name: scene.name, ...(scene.protected ? { needs_confirmation: true } : {}),
            })),
        },
    };
}

/** What the account has and could buy, for advice and for checking offer_plan. */
export interface AccountInfo {
    plan: { code: string; name: string; monthly_tokens: number; expires_at: string | null };
    used_tokens: number;
    resets_at: string;
    plans: Array<{ code: string; name: string; monthly_tokens: number; price_vnd: number; price_12m_vnd: number | null }>;
    payments: boolean;
}

/** Roughly how many tokens one question and answer use (the app shows the same estimate). */
const TOKENS_PER_TURN = 2500;

/** Twelve months cost what the plan says, or twelve times the monthly price (as orders are priced). */
const yearPrice = (plan: AccountInfo['plans'][number]) => plan.price_12m_vnd ?? plan.price_vnd * 12;

const vietnamDay = (iso: string) => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(iso));

export function withAccount(context: HomeContext, account: AccountInfo): HomeContext {
    return {
        ...context,
        plans: account.plans.filter(plan => plan.price_vnd > 0).map(plan => ({
            code: plan.code,
            name: plan.name,
            prices: [
                { months: 1 as const, amount_vnd: plan.price_vnd },
                { months: 12 as const, amount_vnd: yearPrice(plan) },
            ],
        })),
        data: {
            ...context.data,
            account: {
                plan: account.plan.code,
                plan_name: account.plan.name,
                plan_expires_on: account.plan.expires_at ? vietnamDay(account.plan.expires_at) : null,
                used_tokens_this_month: account.used_tokens,
                monthly_tokens: account.plan.monthly_tokens,
                resets_on: vietnamDay(account.resets_at),
                payments: account.payments,
                plans: account.plans.map(plan => ({
                    code: plan.code,
                    name: plan.name,
                    monthly_tokens: plan.monthly_tokens,
                    about_questions_per_month: Math.floor(plan.monthly_tokens / TOKENS_PER_TURN),
                    price_1_month_vnd: plan.price_vnd,
                    price_12_months_vnd: plan.price_vnd > 0 ? yearPrice(plan) : null,
                })),
            },
        },
    };
}

export async function loadHomeContext(app: FastifyInstance, accountId: string): Promise<HomeContext> {
    const [deviceResult, roomResult, scenes, automationResult, home] = await Promise.all([
        app.pg.query(
            `SELECT device.mac, device.name, device.product_id, device.catalog_revision,
                    device.id AS device_id, device.owner_id, membership.created_at AS joined_at,
                    membership.role, membership.room_id,
                    COALESCE(ARRAY_AGG(permission.permission_scope)
                        FILTER (WHERE permission.permission_scope IS NOT NULL), ARRAY[]::text[]) AS granted_permissions
             FROM device_memberships AS membership
             JOIN device_metadata AS device ON device.id = membership.device_id AND device.is_active = true
             LEFT JOIN device_membership_permissions AS permission
               ON permission.device_id = membership.device_id AND permission.account_id = membership.account_id
             WHERE membership.account_id = $1 AND membership.status = 'active'
               AND (membership.expires_at IS NULL OR membership.expires_at > NOW())
             GROUP BY device.id, membership.role, membership.room_id, membership.created_at
             ORDER BY device.name, device.mac
             LIMIT 100`,
            [accountId],
        ),
        app.pg.query('SELECT id, name FROM rooms WHERE account_id = $1', [accountId]),
        listScenes(app, accountId),
        app.pg.query(
            'SELECT id, name, scene_id FROM automations WHERE account_id = $1 ORDER BY name, id LIMIT 50',
            [accountId],
        ),
        weatherEnabled() ? homeLocation(app, accountId) : Promise.resolve(undefined),
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
        automations: automationResult.rows.map(row => ({ id: row.id, name: row.name, scene_id: row.scene_id ?? null })),
        weather: home === undefined ? undefined : home ? { place: home.place } : null,
    });
}
