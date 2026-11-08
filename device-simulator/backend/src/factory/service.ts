import crypto from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { env } from '../config/env';
import { getProduct } from '../catalog/loader';
import { resolveDeviceProduct } from '../catalog/device-contract';
import type { SimulatedDeviceRecord } from '../domain/registry';
import { recordSimulatorEvent } from '../events/service';
import { getMainMongoDb, getMongoDb } from '../infrastructure/mongodb/client';
import { getPgPool } from '../infrastructure/postgres/client';
import { getMediaStore } from '../media';
import { createMockDeviceIdentity, provisionMockDevice } from '../provisioning/factory';
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

export interface DeviceOwnerView {
    device_id: string;
    device_name: string;
    account_email: string | null;
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

const factoryDependencies = {
    registryDb: getMongoDb,
    mainDb: getMainMongoDb,
    pgPool: getPgPool,
    runtimeManager: getRuntimeManager,
    mediaStore: getMediaStore,
    event: recordSimulatorEvent,
};

/**
 * The simulator factory "manufactures" blank devices: each one gets a factory
 * identity in PostgreSQL (`factory_devices`), its own broker account and a QR
 * label, but no owner. A powered-on blank device holds a broker session in
 * pairing mode and becomes a normal device the moment someone claims it from
 * the app, exactly like a physical product taken out of its box.
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

        const displayName = product.presentation?.display_name || product.model_name;
        const macs: string[] = [];
        for (let index = 0; index < input.quantity; index += 1) {
            const sequence = await this.nextSequence('serial');
            const serial = formatSerialNumber(product.product_id, manufacturedAt, sequence);
            const identity = await this.createAvailableIdentity();
            const now = new Date();
            const record: SimulatedDeviceRecord = {
                run_id: FACTORY_RUN_ID,
                simulator_user_id: '',
                origin: 'factory',
                factory_batch_id: batch.id,
                serial_number: serial,
                generation_index: sequence,
                mac: identity.mac,
                name: `${displayName} ${serial.slice(-4)}`,
                product_id: product.product_id,
                catalog_revision: product.catalog_revision,
                simulated_network_index: 0,
                network_fingerprint: '',
                secret: encrypt(identity.rawSecret),
                ...(product.product_id === ENTRANCE_PRODUCT_ID
                    ? { access_pin: encrypt(generateAccessPin()) }
                    : {}),
                credential_private_key: encrypt(identity.credentialPrivateKeyPem),
                credential_public_key_pem: identity.credentialPublicKeyPem,
                factory_owned: false,
                provisioning_state: 'planned',
                runtime_state: 'offline',
                desired_state: input.power_on ? 'online' : 'offline',
                seq: 0,
                retention_policy: 'permanent',
                created_at: now,
                updated_at: now,
            };
            await this.devices().insertOne(record);
            await provisionMockDevice(product, identity);
            await this.devices().updateOne(
                { mac: identity.mac },
                { $set: { provisioning_state: 'provisioned', factory_owned: true, updated_at: new Date() } },
            );
            // The broker account is flashed at the factory, before the first power-on.
            await this.manager.resolveBrokerCredentials(identity.mac);
            macs.push(identity.mac);
        }

        await this.dependencies.event({
            type: 'factory.batch_manufactured',
            severity: 'info',
            run_id: FACTORY_RUN_ID,
            message: `Manufactured ${macs.length} blank ${product.product_id} devices`,
            data: { batch_id: batch.id, product_id: product.product_id, quantity: macs.length },
        }).catch(() => undefined);

        if (input.power_on) {
            await Promise.allSettled(macs.map((mac) => this.startRuntime(mac).catch((error) => {
                this.logger.warn({ err: error, mac }, 'Factory device could not power on after manufacturing');
            })));
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
        const owners = await this.loadOwners(records.map((record) => record.mac));
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
            runtime_state: record.runtime_state,
            desired_state: record.desired_state,
            created_at: new Date(record.created_at).toISOString(),
            owner: owners.get(record.mac) || null,
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
        const [owners, factory] = await Promise.all([
            this.loadOwners([mac]),
            this.dependencies.pgPool().query<{ is_claimed: boolean }>(
                'SELECT is_claimed FROM factory_devices WHERE mac = $1',
                [mac],
            ),
        ]);
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
            claimable: factory.rows[0]?.is_claimed === false,
            owner: owners.get(mac) || null,
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
        if (record.provisioning_state === 'claimed' && !await this.hasActiveOwner(mac)) {
            // Unpaired while switched off: the retained assignment is gone, so
            // the device would never learn it on its own. Reset it now.
            await this.manager.revokeDeviceOwnership(mac);
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
     * Destroys an unsold device: its factory identity, broker account, registry
     * record and recordings. A device somebody owns cannot be scrapped.
     */
    async scrap(macInput: string): Promise<void> {
        const mac = normalizeMac(macInput);
        const record = await this.requireFactoryDevice(mac);
        await this.manager.removeDevice(mac);
        let deleted = 0;
        try {
            const result = await this.dependencies.pgPool().query(
                'DELETE FROM factory_devices WHERE mac = $1 AND is_claimed = false RETURNING mac',
                [mac],
            );
            deleted = result.rowCount || 0;
            if (deleted === 0) {
                const exists = await this.dependencies.pgPool().query(
                    'SELECT 1 FROM factory_devices WHERE mac = $1',
                    [mac],
                );
                if (exists.rows.length === 0) deleted = 1;
            }
        } catch (error) {
            this.logger.warn({ err: error, mac }, 'Factory identity could not be deleted');
        }
        if (deleted === 0) {
            if (record.desired_state === 'online') await this.startRuntime(mac).catch(() => undefined);
            throw httpError(409, 'DEVICE_OWNED', 'The device belongs to an account; it must be unpaired in the app first');
        }
        await this.manager.revokeBrokerIdentity(mac).catch((error) => this.logger.warn(
            { err: error, mac },
            'Broker identity of a scrapped device could not be revoked',
        ));
        await this.dependencies.mediaStore().wipeCamera(FACTORY_RUN_ID, mac).catch(() => undefined);
        const mainDb = this.dependencies.mainDb();
        await Promise.allSettled([
            mainDb.collection<{ _id: string }>(env.MAIN_MONGO_DEVICE_SHADOWS_COLLECTION).deleteMany({ _id: mac }),
            mainDb.collection(env.MAIN_MONGO_TELEMETRY_COLLECTION).deleteMany({ 'metadata.device_id': mac }),
            mainDb.collection('active_operations').deleteMany({ device_id: mac }),
            mainDb.collection(env.MAIN_MONGO_DEVICE_EVENTS_COLLECTION).deleteMany({ device_id: mac }),
            mainDb.collection('device_incidents').deleteMany({ device_id: mac }),
            mainDb.collection(env.MAIN_MONGO_INGEST_RECEIPTS_COLLECTION).deleteMany({ device_id: mac }),
        ]);
        await this.devices().deleteOne({ mac, origin: 'factory' });
        await this.dependencies.event({
            type: 'factory.device_scrapped',
            severity: 'warning',
            run_id: FACTORY_RUN_ID,
            mac,
            message: 'Unsold factory device was scrapped',
            data: { serial_number: record.serial_number || null, batch_id: record.factory_batch_id || null },
        }).catch(() => undefined);
    }

    /** Scraps every device of a lot that nobody owns; removes the lot when it is empty. */
    async scrapUnclaimed(batchId: string): Promise<{ scrapped: number; kept: number }> {
        const records = await this.devices()
            .find({ origin: 'factory', factory_batch_id: batchId }, { projection: { mac: 1, provisioning_state: 1 } })
            .toArray();
        if (records.length === 0 && !await this.batches().findOne({ id: batchId })) {
            throw httpError(404, 'BATCH_NOT_FOUND', 'Production lot not found');
        }
        let scrapped = 0;
        let kept = 0;
        for (const record of records) {
            if (record.provisioning_state === 'claimed') {
                kept += 1;
                continue;
            }
            try {
                await this.scrap(record.mac);
                scrapped += 1;
            } catch {
                kept += 1;
            }
        }
        if (kept === 0) await this.batches().deleteOne({ id: batchId });
        return { scrapped, kept };
    }

    /** Powers on factory devices whose switch was on before the simulator restarted. */
    async recover(): Promise<number> {
        const records = await this.devices()
            .find({ origin: 'factory', desired_state: 'online' }, { projection: { mac: 1 } })
            .toArray();
        let started = 0;
        for (const record of records) {
            try {
                if (await this.powerOn(record.mac)) started += 1;
            } catch (error) {
                this.logger.warn({ err: error, mac: record.mac }, 'Factory device could not be powered on after restart');
            }
        }
        if (records.length > 0) this.logger.info({ started, total: records.length }, 'Factory devices recovered');
        return started;
    }

    /** Starts the firmware of a device whose power switch is on. */
    async startRuntime(macInput: string): Promise<DeviceRuntime | null> {
        const mac = normalizeMac(macInput);
        const record = await this.devices().findOne({ mac, origin: 'factory' });
        if (!record || record.desired_state !== 'online' || record.provisioning_state === 'planned') return null;
        const runtime = await this.runtimeFor(record);
        await runtime.connect();
        return runtime;
    }

    private async requireFactoryDevice(mac: string): Promise<SimulatedDeviceRecord> {
        const record = await this.devices().findOne({ mac, origin: 'factory' });
        if (!record) throw httpError(404, 'DEVICE_NOT_FOUND', 'Factory device not found');
        return record;
    }

    private async hasActiveOwner(mac: string): Promise<boolean> {
        const result = await this.dependencies.pgPool().query(
            'SELECT 1 FROM device_metadata WHERE mac = $1 AND is_active = true',
            [mac],
        );
        return result.rows.length > 0;
    }

    private async loadOwners(macs: string[]): Promise<Map<string, DeviceOwnerView>> {
        if (macs.length === 0) return new Map();
        const result = await this.dependencies.pgPool().query<{
            mac: string;
            id: string;
            name: string;
            email: string | null;
            claimed_at: Date | null;
        }>(
            `SELECT device.mac, device.id::text AS id, device.name, account.email, device.claimed_at
             FROM device_metadata AS device
             LEFT JOIN accounts AS account ON account.id = device.owner_id
             WHERE device.mac = ANY($1::text[]) AND device.is_active = true`,
            [macs],
        );
        return new Map(result.rows.map((row) => [row.mac, {
            device_id: row.id,
            device_name: row.name,
            account_email: row.email,
            claimed_at: iso(row.claimed_at),
        }]));
    }

    private async createAvailableIdentity() {
        for (let attempt = 0; attempt < 20; attempt += 1) {
            const identity = await createMockDeviceIdentity(crypto.randomUUID(), 'factory');
            const [factoryRecord, registryRecord] = await Promise.all([
                this.dependencies.pgPool().query('SELECT 1 FROM factory_devices WHERE mac = $1', [identity.mac]),
                this.devices().findOne({ mac: identity.mac }, { projection: { _id: 1 } }),
            ]);
            if (factoryRecord.rows.length === 0 && !registryRecord) return identity;
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
