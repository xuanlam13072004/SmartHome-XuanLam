import type { FastifyInstance } from 'fastify';
import type Redis from 'ioredis';
import { REDIS_CHANNELS } from '../../../shared/constants';
import { compare, isPresenceProperty, type Operator, readPath } from '../modules/automations/catalog';
import { fireDeviceTrigger, releaseStateTrigger } from '../modules/automations/firing';

/**
 * Watches device telemetry, events and presence (the Redis channels the MQTT
 * worker already publishes for the apps) and fires automations whose trigger
 * is a device. An in-memory index MAC → enabled triggers keeps the cost of a
 * device without automations to one Map lookup on the MAC, read before the
 * message is parsed. State triggers keep whether their comparison holds and
 * fire only when it becomes true; the database row decides who acts
 * (modules/automations/firing.ts), so every Gateway instance may listen.
 * Changes arrive on AUTOMATION_CHANGED; a full reload every few minutes
 * repairs anything missed. Events published while no Gateway listens are not
 * replayed.
 */

const RESYNC_MS = 5 * 60 * 1000;
const MAC_FIELD = /"mac":"([0-9A-F]{2}(?::[0-9A-F]{2}){5})"/;

interface TriggerEntry {
    id: string;
    mac: string;
    kind: 'state' | 'event';
    property: string | null;
    operator: Operator | null;
    value: unknown;
    event: string | null;
    /** Whether the comparison holds, as last seen (state triggers). */
    matched: boolean;
    /** This trigger's database work, in arrival order. */
    chain: Promise<unknown>;
}

const INDEX_QUERY = `SELECT automation.id, automation.trigger_kind, automation.trigger_property,
        automation.trigger_operator, automation.trigger_value, automation.trigger_event,
        automation.trigger_matched, device.mac
    FROM automations AS automation
    JOIN device_metadata AS device ON device.id = automation.trigger_device_id
    WHERE automation.enabled AND automation.trigger_device_id IS NOT NULL`;

export class AutomationEngine {
    private subscriber: Redis | null = null;
    private resyncTimer: NodeJS.Timeout | null = null;
    private byDevice = new Map<string, TriggerEntry[]>();
    private byId = new Map<string, TriggerEntry>();
    private pending = new Set<Promise<unknown>>();

    constructor(private readonly app: FastifyInstance) {}

    async start() {
        await this.reloadAll();
        this.subscriber = this.app.redis.duplicate();
        this.subscriber.on('message', (channel: string, raw: string) => this.dispatch(channel, raw));
        await this.subscriber.subscribe(
            REDIS_CHANNELS.DEVICE_TELEMETRY,
            REDIS_CHANNELS.DEVICE_EVENT,
            REDIS_CHANNELS.DEVICE_STATUS,
            REDIS_CHANNELS.AUTOMATION_CHANGED,
        );
        this.resyncTimer = setInterval(() => this.track(this.reloadAll()), RESYNC_MS);
        this.resyncTimer.unref();
    }

    async stop() {
        if (this.resyncTimer) clearInterval(this.resyncTimer);
        this.resyncTimer = null;
        await this.subscriber?.quit().catch(() => undefined);
        this.subscriber = null;
        await this.idle();
    }

    /** Resolves when all database work started so far has finished. */
    async idle() {
        while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
    }

    get size() {
        return this.byId.size;
    }

    private track(work: Promise<unknown>) {
        const tracked = work.catch(error => this.app.log.error({ error }, 'Automation engine work failed'));
        this.pending.add(tracked);
        void tracked.finally(() => this.pending.delete(tracked));
    }

    private dispatch(channel: string, raw: string) {
        if (channel === REDIS_CHANNELS.AUTOMATION_CHANGED) {
            const id = parse(raw)?.id;
            if (typeof id === 'string') this.track(this.reloadOne(id));
            return;
        }
        // Most devices have no automation: skip them before parsing.
        const mac = MAC_FIELD.exec(raw.slice(0, 300))?.[1];
        if (!mac || !this.byDevice.has(mac)) return;
        const message = parse(raw);
        if (!message) return;
        if (channel === REDIS_CHANNELS.DEVICE_TELEMETRY) this.handleTelemetry(message);
        else if (channel === REDIS_CHANNELS.DEVICE_EVENT) this.handleEvent(message);
        else if (channel === REDIS_CHANNELS.DEVICE_STATUS) this.handleStatus(message);
    }

    /** `{ mac, payload: { instances, diagnostics } }`: state triggers whose property is in the patch. */
    handleTelemetry(message: any) {
        for (const entry of this.byDevice.get(message?.mac) ?? []) {
            if (entry.kind !== 'state' || isPresenceProperty(entry.property!)) continue;
            const value = readPath(message.payload, entry.property!);
            if (value !== undefined) this.observe(entry, compare(value, entry.operator!, entry.value));
        }
    }

    /** `{ mac, payload: { is_online } }` from presence: connectivity triggers. */
    handleStatus(message: any) {
        const online = message?.payload?.is_online;
        if (typeof online !== 'boolean') return;
        for (const entry of this.byDevice.get(message.mac) ?? []) {
            if (entry.kind === 'state' && isPresenceProperty(entry.property!)) {
                this.observe(entry, compare(online, entry.operator!, entry.value));
            }
        }
    }

    /** `{ mac, payload: { event_id, instance_id, event_name } }`. */
    handleEvent(message: any) {
        const payload = message?.payload;
        if (typeof payload?.event_id !== 'string') return;
        const key = `${payload.instance_id}.${payload.event_name}`;
        for (const entry of this.byDevice.get(message.mac) ?? []) {
            if (entry.kind === 'event' && entry.event === key) {
                this.enqueue(entry, () => fireDeviceTrigger(this.app, entry.id, { eventId: payload.event_id }));
            }
        }
    }

    private observe(entry: TriggerEntry, holds: boolean) {
        if (holds === entry.matched) return;
        entry.matched = holds;
        this.enqueue(entry, holds
            ? () => fireDeviceTrigger(this.app, entry.id)
            : () => releaseStateTrigger(this.app, entry.id));
    }

    private enqueue(entry: TriggerEntry, work: () => Promise<unknown>) {
        entry.chain = entry.chain.then(work, work);
        this.track(entry.chain);
    }

    private toEntry(row: any): TriggerEntry {
        return {
            id: row.id,
            mac: row.mac,
            kind: row.trigger_kind,
            property: row.trigger_property,
            operator: row.trigger_operator,
            value: row.trigger_value,
            event: row.trigger_event,
            matched: row.trigger_matched,
            chain: this.byId.get(row.id)?.chain ?? Promise.resolve(),
        };
    }

    private remove(id: string) {
        const entry = this.byId.get(id);
        if (!entry) return;
        this.byId.delete(id);
        const list = (this.byDevice.get(entry.mac) ?? []).filter(item => item.id !== id);
        if (list.length > 0) this.byDevice.set(entry.mac, list);
        else this.byDevice.delete(entry.mac);
    }

    private add(entry: TriggerEntry) {
        this.byId.set(entry.id, entry);
        this.byDevice.set(entry.mac, [...(this.byDevice.get(entry.mac) ?? []), entry]);
    }

    /** Rebuilds the whole index from the database. */
    async reloadAll() {
        const rows = (await this.app.pg.query(INDEX_QUERY)).rows;
        const entries = rows.map(row => this.toEntry(row));
        this.byId = new Map();
        this.byDevice = new Map();
        for (const entry of entries) this.add(entry);
    }

    /** Reloads one automation after it was created, changed or deleted. */
    async reloadOne(id: string) {
        const row = (await this.app.pg.query(`${INDEX_QUERY} AND automation.id = $1`, [id])).rows[0];
        const entry = row ? this.toEntry(row) : null;
        this.remove(id);
        if (entry) this.add(entry);
    }
}

function parse(raw: string): any {
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}
