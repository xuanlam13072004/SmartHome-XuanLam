import crypto from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { env } from '../config/env';
import { getProduct } from '../catalog/loader';
import { resolveDeviceProduct } from '../catalog/device-contract';
import type { SimulatedDeviceRecord } from '../domain/registry';
import { recordSimulatorEvent } from '../events/service';
import { apiGateway } from '../infrastructure/api-gateway/client';
import { getMongoDb } from '../infrastructure/mongodb/client';
import { getMediaStore } from '../media';
import {
    createMockDeviceIdentity,
    factoryBody,
    provisionMockDevices,
    retireMockDevices,
} from '../provisioning/factory';
import { verifyLiveOwnershipBatch } from '../provisioning/ownership';
import { getRuntimeManager, type RuntimeManager } from '../runtime/manager';
import type { DeviceRuntime } from '../runtime/device-runtime';
import { assignmentFromClaim } from '../runtime/topology';
import { decrypt, encrypt } from '../security/crypto';
import { ENTRANCE_PRODUCT_ID, ensureAccessPin, generateAccessPin } from '../security/device-pin';
import {
    buildPairingPayload,
    encodePairingPayload,
    FACTORY_RUN_ID,
    factoryRunContext,
    formatBatchId,
    formatSerialNumber,
} from './pairing';

export interface FactoryBatchRecord {
    id: string;
    product_id: string;
    catalog_revision: number;
    quantity: number;
    power_on: boolean;
    note?: string;
    created_at: Date;
}

export interface FactoryBatchView extends Omit<FactoryBatchRecord, 'created_at'> {
    created_at: string;
    in_stock: number;
    claimed: number;
    powered_on: number;
}

/**
 * What the factory knows about a sold device: that it was claimed, when, and
 * its id in the system (from the claim assignment the device received). Who
 * bought it stays in the system: the Simulator, like a real factory, never
 * reads the buyer's account.
 */
export interface DeviceOwnerView {
    device_id: string | null;
    claimed_at: string | null;
}

export interface FactoryDeviceView {
    mac: string;
    serial_number: string | null;
    name: string;
    product_id: string;
    catalog_revision: number | null;
    factory_batch_id: string | null;
    provisioning_state: SimulatedDeviceRecord['provisioning_state'];
    runtime_state: SimulatedDeviceRecord['runtime_state'];
    desired_state: SimulatedDeviceRecord['desired_state'];
    created_at: string;
    owner: DeviceOwnerView | null;
    /** QR content; only present when the caller asked for labels. */
    pairing_payload?: string;
}

export interface DevicePairingView {
    mac: string;
    serial_number: string | null;
    product_id: string;
    origin: 'run' | 'factory';
    payload: string;
    /** False while some account owns the device (the app would answer DEVICE_ALREADY_CLAIMED). */
    claimable: boolean;
    owner: DeviceOwnerView | null;
}

const httpError = (statusCode: number, code: string, message: string) => Object.assign(
    new Error(message),
    { statusCode, code },
);

const normalizeMac = (value: string): string => value.trim().toUpperCase();

const iso = (value?: Date | string | null): string | null => (
    value ? new Date(value).toISOString() : null
);

const ownerOf = (record: Pick<SimulatedDeviceRecord, 'provisioning_state' | 'device_id' | 'claimed_at'>): DeviceOwnerView | null => (
    record.provisioning_state === 'claimed'
        ? { device_id: record.device_id ?? null, claimed_at: iso(record.claimed_at) }
        : null
);

const factoryDependencies = {
    registryDb: getMongoDb,
    runtimeManager: getRuntimeManager,
    mediaStore: getMediaStore,
    event: recordSimulatorEvent,
    gateway: apiGateway as Pick<typeof apiGateway, 'factoryDeviceStatus'>,
    provision: provisionMockDevices,
    retire: retireMockDevices,
};

const MAX_IDENTITY_ATTEMPTS = 20;

/**
 * The simulator factory "manufactures" blank devices: each one gets an
 * identity (MAC, claim secret, MQTT password, key pair) kept in the
 * Simulator's registry, is registered with the system's factory API (hashes
 * only) and gets a QR label, but no owner. A powered-on blank device holds a
 * broker session in pairing mode and becomes a normal device the moment
 * someone claims it from the app, exactly like a physical product.
 */
export class FactoryService {
    private readonly logger: FastifyBaseLogger;
    private manufacturing = Promise.resolve();

    constructor(logger: FastifyBaseLogger, private readonly dependencies = factoryDependencies) {
        this.logger = logger.child({ module: 'FactoryService' });
    }

    private get manager(): RuntimeManager {
        return this.dependencies.runtimeManager(this.logger);
    }

    private devices() {
        return this.dependencies.registryDb().collection<SimulatedDeviceRecord>('simulated_devices');
    }

    private batches() {
        return this.dependencies.registryDb().collection<FactoryBatchRecord>('factory_batches');
    }

    /** Subscribes to claim/unpair notifications of the runtime manager. */
    attach(): void {
        this.manager.setFactoryLifecycleListener({
            onClaimed: (mac, deviceId) => {
                void this.dependencies.event({
                    type: 'factory.device_claimed',
                    severity: 'info',
                    run_id: FACTORY_RUN_ID,
                    mac,
                    message: 'Factory device was claimed from its QR label',
                    data: { device_id: deviceId },
                }).catch(() => undefined);
            },
            onReleased: async (mac) => {
                await this.dependencies.event({
                    type: 'factory.device_released',
                    severity: 'info',
                    run_id: FACTORY_RUN_ID,
                    mac,
                    message: 'Factory device was unpaired by its owner and reset to pairing mode',
                }).catch(() => undefined);
                await this.startRuntime(mac);
            },
        });
    }

    /** Manufactures one lot. Lots are produced one after another. */
    manufacture(input: {
        product_id: string;
        quantity: number;
        power_on: boolean;
        note?: string;
    }): Promise<{ batch: FactoryBatchView; devices: FactoryDeviceView[] }> {
        const task = this.manufacturing.then(() => this.manufactureLot(input));
        this.manufacturing = task.then(() => undefined, () => undefined);
        return task;
    }

    private async manufactureLot(input: {
        product_id: string;
        quantity: number;
        power_on: boolean;
        note?: string;
    }): Promise<{ batch: FactoryBatchView; devices: FactoryDeviceView[] }> {
        if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > env.FACTORY_MAX_BATCH_SIZE) {
            throw httpError(400, 'INVALID_QUANTITY', `Quantity must be between 1 and ${env.FACTORY_MAX_BATCH_SIZE}`);
        }
        let product;
        try {
            product = getProduct(input.product_id);
        } catch {
            throw httpError(400, 'UNKNOWN_PRODUCT', 'Product is not published in the runtime catalog');
        }
        const manufacturedAt = new Date();
        const batch: FactoryBatchRecord = {
            id: formatBatchId(manufacturedAt, await this.nextSequence('lot')),
            product_id: product.product_id,
            catalog_revision: product.catalog_revision,
            quantity: input.quantity,
            power_on: input.power_on,
            ...(input.note?.trim() ? { note: input.note.trim().slice(0, 120) } : {}),
            created_at: manufacturedAt,
        };
        await this.batches().insertOne({ ...batch });

        // 1. Identities, kept in the registry before anything leaves the Simulator.
        const displayName = product.presentation?.display_name || product.model_name;
        const records: SimulatedDeviceRecord[] = [];
        for (let index = 0; index < input.quantity; index += 1) {
            const sequence = await this.nextSequence('serial');
            const serial = formatSerialNumber(product.product_id, manufacturedAt, sequence);
            const now = new Date();
            records.push({
                run_id: FACTORY_RUN_ID,
                simulator_user_id: '',
                origin: 'factory',
                factory_batch_id: batch.id,
                serial_number: serial,
                generation_index: sequence,
                ...await this.freeIdentity(),
                name: `${displayName} ${serial.slice(-4)}`,
                product_id: product.product_id,
                catalog_revision: product.catalog_revision,
                simulated_network_index: 0,
                network_fingerprint: '',
                ...(product.product_id === ENTRANCE_PRODUCT_ID
                    ? { access_pin: encrypt(generateAccessPin()) }
                    : {}),
                provisioning_state: 'planned',
                runtime_state: 'offline',
                desired_state: input.power_on ? 'online' : 'offline',
                seq: 0,
                retention_policy: 'permanent',
                created_at: now,
                updated_at: now,
            });
        }
        await this.devices().insertMany(records.map((record) => ({ ...record })));

        // 2. The factory API, 200 per call; a MAC the system already has gets a new identity.
        let pending = records;
        for (let attempt = 1; pending.length > 0; attempt += 1) {
            if (attempt > MAX_IDENTITY_ATTEMPTS) throw new Error('Could not allocate a free MAC address for a factory device');
            const statuses = await this.dependencies.provision(pending.map((record) => factoryBody(product, {
                mac: record.mac,
                credentialPublicKeyPem: record.credential_public_key_pem,
                factory: record.factory,
            })));
            const ready = pending.filter((record) => ['created', 'exists'].includes(statuses.get(record.mac) ?? ''));
            if (pending.some((record) => statuses.get(record.mac) === 'product_unknown')) {
                throw httpError(409, 'PRODUCT_NOT_PUBLISHED', 'The system does not publish this Product revision');
            }
            if (ready.length > 0) {
                await this.devices().updateMany(
                    { mac: { $in: ready.map((record) => record.mac) } },
                    { $set: { provisioning_state: 'provisioned', updated_at: new Date() } },
                );
            }
            const conflicts = pending.filter((record) => statuses.get(record.mac) === 'conflict');
            for (const record of conflicts) {
                const previousMac = record.mac;
                const identity = await this.freeIdentity();
                await this.devices().updateOne({ mac: previousMac }, { $set: { ...identity, updated_at: new Date() } });
                Object.assign(record, identity);
            }
            pending = conflicts;
        }
        const macs = records.map((record) => record.mac);

        await this.dependencies.event({
            type: 'factory.batch_manufactured',
            severity: 'info',
            run_id: FACTORY_RUN_ID,
            message: `Manufactured ${macs.length} blank ${product.product_id} devices`,
            data: { batch_id: batch.id, product_id: product.product_id, quantity: macs.length },
        }).catch(() => undefined);

        if (input.power_on) {
            for (const mac of macs) {
                await this.startRuntime(mac, { queued: true }).catch((error) => {
                    this.logger.warn({ err: error, mac }, 'Factory device could not power on after manufacturing');
                });
            }
        }
        const [view] = await this.listBatches(batch.id);
        return { batch: view, devices: await this.listDevices({ batchId: batch.id, includePairing: true }) };
    }

    async listBatches(batchId?: string): Promise<FactoryBatchView[]> {
        const batches = await this.batches()
            .find(batchId ? { id: batchId } : {}, { projection: { _id: 0 } })
            .sort({ created_at: -1 })
            .limit(200)
            .toArray();
        if (batches.length === 0) return [];
        const counts = await this.devices().aggregate<{
            _id: string;
            total: number;
            claimed: number;
            powered_on: number;
        }>([
            { $match: { origin: 'factory', factory_batch_id: { $in: batches.map((batch) => batch.id) } } },
            {
                $group: {
                    _id: '$factory_batch_id',
                    total: { $sum: 1 },
                    claimed: { $sum: { $cond: [{ $eq: ['$provisioning_state', 'claimed'] }, 1, 0] } },
                    powered_on: { $sum: { $cond: [{ $eq: ['$desired_state', 'online'] }, 1, 0] } },
                },
            },
        ]).toArray();
        const byBatch = new Map(counts.map((count) => [count._id, count]));
        return batches.map((batch) => {
            const count = byBatch.get(batch.id);
            return {
                ...batch,
                created_at: new Date(batch.created_at).toISOString(),
                in_stock: (count?.total || 0) - (count?.claimed || 0),
                claimed: count?.claimed || 0,
                powered_on: count?.powered_on || 0,
            };
        });
    }

    async listDevices(options: { batchId?: string; includePairing?: boolean } = {}): Promise<FactoryDeviceView[]> {
        const records = await this.devices()
            .find(
                { origin: 'factory', ...(options.batchId ? { factory_batch_id: options.batchId } : {}) },
                {
                    projection: {
                        access_pin: 0,
                        credential_private_key: 0,
                        mqtt_secret: 0,
                        factory: 0,
                        pending_device_events: 0,
                        state_snapshot: 0,
                        irrigation_session: 0,
                        ...(options.includePairing ? {} : { secret: 0 }),
                    },
                },
            )
            .sort({ generation_index: -1 })
            .limit(500)
            .toArray();
        if (options.includePairing && records.length > 0) {
            await this.dependencies.event({
                type: 'security.pairing_labels_viewed',
                severity: 'info',
                run_id: FACTORY_RUN_ID,
                message: `Pairing labels of ${records.length} factory devices were opened`,
                data: { batch_id: options.batchId || null, count: records.length },
            }).catch(() => undefined);
        }
        return records.map((record) => ({
            mac: record.mac,
            serial_number: record.serial_number || null,
            name: record.name,
            product_id: record.product_id,
            catalog_revision: record.catalog_revision ?? null,
            factory_batch_id: record.factory_batch_id || null,
            provisioning_state: record.provisioning_state,
            runtime_state: this.manager.getDevice(record.mac)?.liveRuntimeState ?? record.runtime_state,
            desired_state: record.desired_state,
            created_at: new Date(record.created_at).toISOString(),
            owner: ownerOf(record),
            ...(options.includePairing && record.secret ? {
                pairing_payload: encodePairingPayload(buildPairingPayload(
                    record.mac,
                    decrypt(record.secret.iv, record.secret.encrypted, record.secret.authTag),
                )),
            } : {}),
        }));
    }

    /** QR label of any simulated device: run-generated or manufactured. */
    async pairing(macInput: string): Promise<DevicePairingView> {
        const mac = normalizeMac(macInput);
        const record = await this.devices().findOne({ mac });
        if (!record) throw httpError(404, 'DEVICE_NOT_FOUND', 'Device not found');
        const [status] = await this.dependencies.gateway.factoryDeviceStatus([mac]);
        await this.dependencies.event({
            type: 'security.pairing_label_viewed',
            severity: 'info',
            run_id: record.run_id,
            ...(record.simulator_user_id ? { account_id: record.simulator_user_id } : {}),
            mac,
            message: 'Device pairing label (QR) was opened',
        }).catch(() => undefined);
        return {
            mac,
            serial_number: record.serial_number || null,
            product_id: record.product_id,
            origin: record.origin === 'factory' ? 'factory' : 'run',
            payload: encodePairingPayload(buildPairingPayload(
                mac,
                decrypt(record.secret.iv, record.secret.encrypted, record.secret.authTag),
            )),
            claimable: status?.exists === true && status.claimed === false,
            owner: status?.claimed ? (ownerOf(record) ?? { device_id: null, claimed_at: null }) : null,
        };
    }

    /** Power switch on. A claimed device first checks that it still has an owner. */
    async powerOn(macInput: string): Promise<DeviceRuntime | null> {
        const mac = normalizeMac(macInput);
        const record = await this.requireFactoryDevice(mac);
        await this.devices().updateOne(
            { mac },
            { $set: { desired_state: 'online', updated_at: new Date() } },
        );
        if (record.provisioning_state === 'claimed') {
            // Unpaired while switched off: the retained assignment is gone, so
            // the device would never learn it on its own. verifyLive… resets it.
            await verifyLiveOwnershipBatch([record], this.manager, this.status());
        }
        return this.startRuntime(mac);
    }

    async powerOff(macInput: string): Promise<void> {
        const mac = normalizeMac(macInput);
        await this.requireFactoryDevice(mac);
        await this.devices().updateOne(
            { mac },
            { $set: { desired_state: 'offline', runtime_state: 'offline', updated_at: new Date() } },
        );
        await this.manager.removeDevice(mac);
    }

    /** Runtime of a factory device in its current ownership state, created on demand. */
    async runtimeFor(record: SimulatedDeviceRecord): Promise<DeviceRuntime> {
        const product = await resolveDeviceProduct(record);
        const run = factoryRunContext();
        return this.manager.addDevice(
            FACTORY_RUN_ID,
            record.mac,
            product,
            run.config.telemetry_interval * 1000,
            run.config.telemetry_jitter_percent,
            run.config.startup_ramp_seconds,
            record.seq || 0,
            record.state_snapshot,
            assignmentFromClaim(record),
            await ensureAccessPin(record),
            record.irrigation_session,
            { awaitClaim: record.provisioning_state !== 'claimed' },
        );
    }

    /**
     * Destroys an unsold device: retired with the factory API (its factory
     * record, MQTT login and the system's data about it), then its registry
     * record and recordings. A device somebody owns cannot be scrapped.
     */
    async scrap(macInput: string): Promise<void> {
        const mac = normalizeMac(macInput);
        const record = await this.requireFactoryDevice(mac);
        const { scrapped } = await this.scrapRecords([record]);
        if (scrapped === 0) {
            throw httpError(409, 'DEVICE_OWNED', 'The device belongs to an account; it must be unpaired in the app first');
        }
    }

    /** Scraps every device of a lot that nobody owns; removes the lot when it is empty. */
    async scrapUnclaimed(batchId: string): Promise<{ scrapped: number; kept: number }> {
        const records = await this.devices().find({ origin: 'factory', factory_batch_id: batchId }).toArray();
        if (records.length === 0 && !await this.batches().findOne({ id: batchId })) {
            throw httpError(404, 'BATCH_NOT_FOUND', 'Production lot not found');
        }
        const unclaimed = records.filter((record) => record.provisioning_state !== 'claimed');
        const { scrapped } = await this.scrapRecords(unclaimed);
        const kept = records.length - scrapped;
        if (kept === 0) await this.batches().deleteOne({ id: batchId });
        return { scrapped, kept };
    }

    private async scrapRecords(records: SimulatedDeviceRecord[]): Promise<{ scrapped: number }> {
        if (records.length === 0) return { scrapped: 0 };
        for (const record of records) await this.manager.removeDevice(record.mac);
        const statuses = await this.dependencies.retire(records.map((record) => record.mac));
        let scrapped = 0;
        for (const record of records) {
            if (statuses.get(record.mac) === 'claimed') {
                // Someone owns it after all: switch it back on as it was.
                if (record.desired_state === 'online') await this.startRuntime(record.mac).catch(() => undefined);
                continue;
            }
            await this.dependencies.mediaStore().wipeCamera(FACTORY_RUN_ID, record.mac).catch(() => undefined);
            await this.devices().deleteOne({ mac: record.mac, origin: 'factory' });
            scrapped += 1;
            await this.dependencies.event({
                type: 'factory.device_scrapped',
                severity: 'warning',
                run_id: FACTORY_RUN_ID,
                mac: record.mac,
                message: 'Unsold factory device was scrapped',
                data: { serial_number: record.serial_number || null, batch_id: record.factory_batch_id || null },
            }).catch(() => undefined);
        }
        return { scrapped };
    }

    /**
     * Powers on factory devices whose switch was on before the simulator
     * restarted: ownership checked in batches, connections queued with the
     * connect scheduler.
     */
    async recover(): Promise<number> {
        const records = await this.devices()
            .find({ origin: 'factory', desired_state: 'online', provisioning_state: { $ne: 'planned' } })
            .toArray();
        if (records.length === 0) return 0;
        const claimed = records.filter((record) => record.provisioning_state === 'claimed');
        if (claimed.length > 0) await verifyLiveOwnershipBatch(claimed, this.manager, this.status());
        let started = 0;
        for (const record of records) {
            try {
                if (await this.startRuntime(record.mac, { queued: true })) started += 1;
            } catch (error) {
                this.logger.warn({ err: error, mac: record.mac }, 'Factory device could not be powered on after restart');
            }
        }
        this.logger.info({ started, total: records.length }, 'Factory devices recovered');
        return started;
    }

    /**
     * Starts the firmware of a device whose power switch is on. By hand (the
     * Console's power button) the answer waits for the connection; in bulk
     * (manufacture, restart) the connection is queued.
     */
    async startRuntime(macInput: string, { queued = false }: { queued?: boolean } = {}): Promise<DeviceRuntime | null> {
        const mac = normalizeMac(macInput);
        const record = await this.devices().findOne({ mac, origin: 'factory' });
        if (!record || record.desired_state !== 'online' || record.provisioning_state === 'planned') return null;
        const runtime = await this.runtimeFor(record);
        if (queued) this.manager.scheduleConnect(runtime);
        else await runtime.connect();
        return runtime;
    }

    private status() {
        return (macs: string[]) => this.dependencies.gateway.factoryDeviceStatus(macs);
    }

    private async requireFactoryDevice(mac: string): Promise<SimulatedDeviceRecord> {
        const record = await this.devices().findOne({ mac, origin: 'factory' });
        if (!record) throw httpError(404, 'DEVICE_NOT_FOUND', 'Factory device not found');
        return record;
    }

    /** A new identity whose MAC no record of the registry uses (the factory API catches the system's). */
    private async freeIdentity() {
        for (let attempt = 0; attempt < MAX_IDENTITY_ATTEMPTS; attempt += 1) {
            const identity = await createMockDeviceIdentity(crypto.randomUUID(), 'factory');
            if (!await this.devices().findOne({ mac: identity.mac }, { projection: { _id: 1 } })) {
                return {
                    mac: identity.mac,
                    secret: encrypt(identity.rawSecret),
                    mqtt_secret: encrypt(identity.mqttPassword),
                    factory: identity.factory,
                    credential_private_key: encrypt(identity.credentialPrivateKeyPem),
                    credential_public_key_pem: identity.credentialPublicKeyPem,
                };
            }
        }
        throw new Error('Could not allocate a free MAC address for a factory device');
    }

    private async nextSequence(name: 'lot' | 'serial'): Promise<number> {
        const counter = await this.dependencies.registryDb()
            .collection<{ _id: string; value: number }>('factory_counters')
            .findOneAndUpdate(
                { _id: name },
                { $inc: { value: 1 } },
                { upsert: true, returnDocument: 'after' },
            );
        if (!counter) throw new Error(`Factory counter ${name} is unavailable`);
        return counter.value;
    }
}

let factoryInstance: FactoryService | null = null;
/** The first call (at startup) must pass the application logger. */
export const getFactoryService = (logger?: FastifyBaseLogger): FactoryService => {
    if (!factoryInstance) {
        if (!logger) throw new Error('Factory service is not initialized');
        factoryInstance = new FactoryService(logger);
        factoryInstance.attach();
    }
    return factoryInstance;
};
