import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getProduct } from '../../catalog/loader';
import { resolveDeviceProduct } from '../../catalog/device-contract';
import { env } from '../../config/env';
import type { SimulatedDeviceRecord, SimulatedUserRecord } from '../../domain/registry';
import type { SimulationRun } from '../../domain/simulation-run';
import { recordSimulatorEvent } from '../../events/service';
import {
    generateInitialState,
    patchDeviceState,
    type DeviceState,
    type DeviceStatePatch,
    validateDeviceStatePatch,
} from '../../generation/telemetry-generator';
import { getMongoDb } from '../../infrastructure/mongodb/client';
import { apiGateway } from '../../infrastructure/api-gateway/client';
import { accessTokenFor } from '../../security/user-session';
import { getRuntimeManager, type RuntimeManager } from '../../runtime/manager';
import { decrypt } from '../../security/crypto';
import { ensureAccessPin } from '../../security/device-pin';
import { assignmentFromClaim } from '../../runtime/topology';
import { initializeEntranceController } from '../../runtime/entrance-controller';
import { getFactoryService } from '../../factory/service';
import { factoryRunContext } from '../../factory/pairing';

const deviceProjection = {
    secret: 0,
    access_pin: 0,
    credential_private_key: 0,
    pending_device_events: 0,
} as const;
const statePatchSchema = z.object({
    instances: z.record(z.string(), z.object({
        reported: z.record(z.string(), z.unknown()).optional(),
        desired: z.record(z.string(), z.unknown()).optional(),
    }).strict()).optional(),
    diagnostics: z.record(
        z.string(),
        z.record(z.string(), z.unknown()),
    ).optional(),
}).strict().refine(
    (value) => value.instances !== undefined || value.diagnostics !== undefined,
    { message: 'At least one state section is required' },
);

const physicalSirenActionSchema = z.object({
    action: z.enum(['test_siren', 'mute_siren', 'resume_siren']),
    duration_seconds: z.number().int().optional(),
}).strict().superRefine((value, context) => {
    if (
        value.action === 'test_siren'
        && (
            value.duration_seconds === undefined
            || value.duration_seconds < 1
            || value.duration_seconds > 30
        )
    ) {
        context.addIssue({
            code: 'custom',
            path: ['duration_seconds'],
            message: 'Siren test duration must be between 1 and 30 seconds',
        });
    }
    if (
        value.action === 'mute_siren'
        && (
            value.duration_seconds === undefined
            || ![60, 180, 300, 600, 1800].includes(value.duration_seconds)
        )
    ) {
        context.addIssue({
            code: 'custom',
            path: ['duration_seconds'],
            message: 'Siren mute duration must be 60, 180, 300, 600 or 1800 seconds',
        });
    }
});

const physicalKeypadSchema = z.object({
    key: z.string().trim().toUpperCase().regex(/^[0-9A-D*#]$/),
}).strict();

const physicalDoorSchema = z.object({
    angle_degrees: z.number().finite().min(0).max(180),
    sensor_state: z.enum(['calibrating', 'ready', 'fault']).default('ready'),
}).strict();

const devicesRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
    const runtimeManager = getRuntimeManager(app.log);

    /**
     * Paged device registry for the dashboard. Filtering, counting and paging
     * happen in MongoDB; runtime state is overlaid from live runtimes because
     * the registry copy is written in batches.
     */
    app.get('/api/devices', async (request) => {
        const query = request.query as {
            run_id?: string;
            user_id?: string;
            product_id?: string;
            status?: string;
            origin?: string;
            q?: string;
            page?: string;
            page_size?: string;
            limit?: string;
        };
        const db = getMongoDb();
        const filter: Record<string, unknown> = {};
        if (query.run_id) filter.run_id = query.run_id;
        if (query.user_id) filter.simulator_user_id = query.user_id;
        if (query.product_id) filter.product_id = query.product_id;
        if (query.origin === 'factory') filter.origin = 'factory';
        if (query.origin === 'run') filter.origin = { $ne: 'factory' };
        if (query.status === 'error') filter.runtime_state = { $in: ['mqtt_error', 'contract_error'] };
        else if (query.status === 'offline') filter.runtime_state = { $in: ['offline', 'stopped', 'claimed', 'connecting'] };
        else if (query.status) filter.runtime_state = query.status;
        const search = query.q?.trim();
        if (search) {
            const pattern = new RegExp(escapeRegex(search), 'i');
            const or: Record<string, unknown>[] = [
                { mac: new RegExp(`^${escapeRegex(search.toUpperCase())}`) },
                { name: pattern },
                { serial_number: pattern },
            ];
            if (search.includes('@') || search.length >= 3) {
                const owners = await db.collection<SimulatedUserRecord>('simulated_users')
                    .find({ email: pattern, account_id: { $type: 'string' } }, { projection: { account_id: 1 } })
                    .limit(500)
                    .toArray();
                if (owners.length > 0) or.push({ simulator_user_id: { $in: owners.map((owner) => owner.account_id) } });
            }
            filter.$or = or;
        }
        const pageSize = Math.min(Math.max(Number(query.page_size || query.limit) || 50, 1), env.MAX_PAGE_SIZE);
        const page = Math.max(Number(query.page) || 1, 1);
        const collection = db.collection<SimulatedDeviceRecord>('simulated_devices');
        const [devices, total] = await Promise.all([
            collection
                .find(filter, { projection: { ...deviceProjection, state_snapshot: 0, irrigation_session: 0, mqtt_secret: 0 } })
                // Natural order within each run: Virtual Device 1-1, 1-2 … 2-1 … 10-1.
                .collation(NATURAL_NAME_ORDER)
                .sort({ run_id: 1, name: 1, mac: 1 })
                .skip((page - 1) * pageSize)
                .limit(pageSize)
                .toArray(),
            collection.countDocuments(filter),
        ]);
        const ownerIds = [...new Set(devices.map((device) => device.simulator_user_id).filter(Boolean))];
        const owners = ownerIds.length === 0 ? [] : await db.collection<SimulatedUserRecord>('simulated_users')
            .find({ account_id: { $in: ownerIds } }, { projection: { account_id: 1, email: 1 } })
            .toArray();
        const emailOf = new Map(owners.map((owner) => [owner.account_id, owner.email]));
        return {
            success: true,
            page,
            page_size: pageSize,
            total,
            devices: devices.map((device) => {
                const runtime = runtimeManager.getDevice(device.mac);
                return {
                    ...device,
                    owner_email: emailOf.get(device.simulator_user_id) || null,
                    ...(runtime ? {
                        runtime_state: runtime.liveRuntimeState,
                        last_telemetry: runtime.lastTelemetry || device.last_telemetry,
                    } : {}),
                };
            }),
        };
    });

    app.get('/api/devices/:mac', async (request, reply) => {
        const mac = normalizeMac((request.params as { mac: string }).mac);
        const device = await getMongoDb().collection<SimulatedDeviceRecord>('simulated_devices')
            .findOne({ mac }, { projection: deviceProjection });
        if (!device) return reply.status(404).send({ success: false, error: 'Device not found' });

        const [backendShadow, operations, events, deviceEvents] = await Promise.all([
            loadBackendShadow(device),
            loadOperations(mac, 100),
            loadEvents(mac, 100),
            loadDeviceEvents(device, 100),
        ]);
        const telemetry = loadTelemetry(runtimeManager, mac);
        let productContractCompatible = true;
        let product;
        try {
            product = getProduct(device.product_id, device.catalog_revision);
        } catch {
            productContractCompatible = false;
            product = getProduct(device.product_id);
        }
        const runtime = runtimeManager.getDevice(mac);
        const accessPin = await loadVirtualAccessPin(mac);
        reply.header('Cache-Control', 'no-store');
        return {
            success: true,
            device: withLiveState(device, runtime),
            product,
            product_contract_compatible: productContractCompatible,
            backend_shadow: backendShadow,
            telemetry,
            operations,
            events,
            device_events: deviceEvents,
            virtual_hardware: accessPin
                ? {
                    access_pin: accessPin,
                    entrance: runtime?.entranceStatus || null,
                }
                : null,
        };
    });

    app.get('/api/devices/:mac/live', async (request, reply) => {
        const mac = normalizeMac((request.params as { mac: string }).mac);
        const device = await getMongoDb().collection<SimulatedDeviceRecord>('simulated_devices')
            .findOne({ mac }, { projection: deviceProjection });
        if (!device) return reply.status(404).send({ success: false, error: 'Device not found' });

        const backendShadow = await loadBackendShadow(device);
        const latestTelemetry = loadTelemetry(runtimeManager, mac);
        const runtime = runtimeManager.getDevice(mac);
        reply.header('Cache-Control', 'no-store');
        return {
            success: true,
            device: withLiveState(device, runtime),
            backend_shadow: backendShadow,
            latest_telemetry: latestTelemetry[0] || null,
            entrance: runtime?.entranceStatus || null,
        };
    });

    app.get('/api/devices/:mac/telemetry', async (request, reply) => {
        const mac = normalizeMac((request.params as { mac: string }).mac);
        if (!await deviceExists(mac)) {
            return reply.status(404).send({ success: false, error: 'Device not found' });
        }
        return { success: true, telemetry: loadTelemetry(runtimeManager, mac) };
    });

    app.get('/api/devices/:mac/operations', async (request, reply) => {
        const mac = normalizeMac((request.params as { mac: string }).mac);
        if (!await deviceExists(mac)) {
            return reply.status(404).send({ success: false, error: 'Device not found' });
        }
        const query = request.query as { limit?: string };
        return { success: true, operations: await loadOperations(mac, parseLimit(query.limit)) };
    });

    app.get('/api/devices/:mac/events', async (request, reply) => {
        const mac = normalizeMac((request.params as { mac: string }).mac);
        if (!await deviceExists(mac)) {
            return reply.status(404).send({ success: false, error: 'Device not found' });
        }
        const query = request.query as { limit?: string };
        return { success: true, events: await loadEvents(mac, parseLimit(query.limit)) };
    });

    app.post('/api/devices/:mac/connect', async (request, reply) => {
        const mac = normalizeMac((request.params as { mac: string }).mac);
        const context = await requireClaimedDevice(mac, reply);
        if (!context) return;

        if (context.device.origin === 'factory') {
            const runtime = await getFactoryService(app.log).powerOn(mac);
            await recordDeviceAction(context.device, 'device.connected', 'Factory device powered on');
            return { success: true, runtime_state: runtime?.awaitingClaim ? 'awaiting_claim' : 'online' };
        }
        await getMongoDb().collection<SimulatedDeviceRecord>('simulated_devices').updateOne(
            { mac },
            { $set: { desired_state: 'online', updated_at: new Date() } },
        );
        const runtime = await getOrCreateRuntime(runtimeManager, context);
        await runtime.connect();
        await runtime.resume();
        await recordDeviceAction(context.device, 'device.connected', 'Virtual device connected');
        return { success: true, runtime_state: 'online' };
    });

    app.post('/api/devices/:mac/disconnect', async (request, reply) => {
        const mac = normalizeMac((request.params as { mac: string }).mac);
        const context = await getDeviceContext(mac);
        if (!context) return reply.status(404).send({ success: false, error: 'Device not found' });

        await getMongoDb().collection<SimulatedDeviceRecord>('simulated_devices').updateOne(
            { mac },
            { $set: { desired_state: 'offline', runtime_state: 'offline', updated_at: new Date() } },
        );
        await runtimeManager.removeDevice(mac);
        await recordDeviceAction(context.device, 'device.disconnected', 'Virtual device disconnected');
        return { success: true, runtime_state: 'offline' };
    });

    app.post('/api/devices/:mac/pause', async (request, reply) => {
        const mac = normalizeMac((request.params as { mac: string }).mac);
        const context = await getDeviceContext(mac);
        if (!context) return reply.status(404).send({ success: false, error: 'Device not found' });
        const runtime = runtimeManager.getDevice(mac);
        if (!runtime?.connected) {
            return reply.status(409).send({ success: false, error: 'Device is not online' });
        }
        await runtime.pause();
        await recordDeviceAction(context.device, 'device.paused', 'Virtual device telemetry paused');
        return { success: true, runtime_state: 'paused' };
    });

    app.post('/api/devices/:mac/resume', async (request, reply) => {
        const mac = normalizeMac((request.params as { mac: string }).mac);
        const context = await requireClaimedDevice(mac, reply);
        if (!context) return;
        await getMongoDb().collection<SimulatedDeviceRecord>('simulated_devices').updateOne(
            { mac },
            { $set: { desired_state: 'online', updated_at: new Date() } },
        );
        const runtime = context.device.origin === 'factory'
            ? await getFactoryService(app.log).powerOn(mac)
            : await getOrCreateRuntime(runtimeManager, context);
        if (!runtime) return reply.status(409).send({ success: false, error: 'Device cannot power on' });
        await runtime.connect();
        await runtime.resume();
        await recordDeviceAction(context.device, 'device.resumed', 'Virtual device telemetry resumed');
        return { success: true, runtime_state: 'online' };
    });

    const sendNowHandler = async (request: any, reply: any) => {
        const mac = normalizeMac((request.params as { mac: string }).mac);
        const runtime = runtimeManager.getDevice(mac);
        if (!runtime?.connected || runtime.paused) {
            return reply.status(409).send({
                success: false,
                error: 'Device must be online and running before sending telemetry',
            });
        }
        await runtime.publishNow();
        return reply.status(202).send({ success: true });
    };
    app.post('/api/devices/:mac/telemetry', sendNowHandler);
    app.post('/api/devices/:mac/send-now', sendNowHandler);

    app.post('/api/devices/:mac/force-offline', async (request, reply) => {
        const mac = normalizeMac((request.params as { mac: string }).mac);
        const context = await getDeviceContext(mac);
        if (!context) return reply.status(404).send({ success: false, error: 'Device not found' });
        await runtimeManager.removeDevice(mac);
        await getMongoDb().collection<SimulatedDeviceRecord>('simulated_devices').updateOne(
            { mac },
            {
                $set: {
                    desired_state: 'online',
                    runtime_state: 'offline',
                    updated_at: new Date(),
                },
            },
        );
        await recordDeviceAction(
            context.device,
            'device.forced_offline',
            'Virtual device was forced offline while desired state remains online',
        );
        return { success: true, runtime_state: 'offline', desired_state: 'online' };
    });

    app.post('/api/devices/:mac/reconnect', async (request, reply) => {
        const mac = normalizeMac((request.params as { mac: string }).mac);
        const context = await requireClaimedDevice(mac, reply);
        if (!context) return;
        await runtimeManager.removeDevice(mac);
        if (context.device.origin === 'factory') {
            await getFactoryService(app.log).powerOn(mac);
            await recordDeviceAction(context.device, 'device.reconnected', 'Factory device restarted');
            return { success: true, runtime_state: 'online' };
        }
        await getMongoDb().collection<SimulatedDeviceRecord>('simulated_devices').updateOne(
            { mac },
            { $set: { desired_state: 'online', updated_at: new Date() } },
        );
        const runtime = await getOrCreateRuntime(runtimeManager, context);
        await runtime.connect();
        await recordDeviceAction(context.device, 'device.reconnected', 'Virtual device reconnected');
        return { success: true, runtime_state: 'online' };
    });

    app.post('/api/devices/:mac/reset-state', async (request, reply) => {
        const mac = normalizeMac((request.params as { mac: string }).mac);
        const context = await getDeviceContext(mac);
        if (!context) return reply.status(404).send({ success: false, error: 'Device not found' });
        const runtime = runtimeManager.getDevice(mac);
        const product = await resolveDeviceProduct(context.device);
        let state: DeviceState;
        if (runtime) {
            state = await runtime.resetState();
        } else {
            const initial = generateInitialState(product);
            const entrance = initializeEntranceController(
                initial,
                product,
                Boolean(await ensureAccessPin(context.device)),
            );
            state = entrance?.state || initial;
        }
        if (!runtime) {
            state.state_version = (context.device.state_snapshot?.state_version || 0) + 1;
        }
        if (!runtime) await persistOfflineState(mac, state);
        await recordDeviceAction(context.device, 'device.state_reset', 'Virtual device state reset');
        return { success: true, state };
    });

    app.patch('/api/devices/:mac/state', async (request, reply) => {
        const mac = normalizeMac((request.params as { mac: string }).mac);
        const parsed = statePatchSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.status(400).send({ success: false, error: parsed.error.flatten() });
        }
        const context = await getDeviceContext(mac);
        if (!context) return reply.status(404).send({ success: false, error: 'Device not found' });
        const product = await resolveDeviceProduct(context.device);
        const managedPatch = findManagedEntrancePatch(product, parsed.data);
        if (managedPatch) {
            return reply.status(409).send({
                success: false,
                error: {
                    code: 'FIRMWARE_MANAGED_STATE',
                    message: `${managedPatch} is controlled by the virtual firmware. Use the physical keypad/door API or a backend command.`,
                },
            });
        }
        try {
            validateDeviceStatePatch(product, parsed.data);
        } catch (error) {
            return reply.status(400).send({
                success: false,
                error: {
                    code: 'INVALID_DEVICE_STATE',
                    message: error instanceof Error ? error.message : 'Device state is invalid',
                },
            });
        }
        const runtime = runtimeManager.getDevice(mac)
            || (product.capability_instances.some(i => i.capability_id === 'irrigation_pump')
                ? await getOrCreateRuntime(runtimeManager, context) : undefined);
        const baseState = context.device.state_snapshot
            || generateInitialState(product);
        const state = runtime
            ? await runtime.patchState(parsed.data)
            : patchDeviceState(baseState, product, parsed.data);
        if (!runtime) await persistOfflineState(mac, state);
        await recordDeviceAction(
            context.device,
            'device.state_updated',
            'Virtual device state manually updated',
            parsed.data,
        );
        return {
            success: true,
            state,
            delivery: runtime?.connected ? 'publish_requested' : 'stored_offline',
        };
    });

    app.post('/api/devices/:mac/physical-pump', async (request, reply) => {
        const mac = normalizeMac((request.params as { mac: string }).mac);
        const parsed = z.object({ action: z.enum(['start', 'stop']) }).strict().safeParse(request.body);
        if (!parsed.success) return reply.status(400).send({ success: false, error: parsed.error.flatten() });
        const context = await getDeviceContext(mac);
        if (!context) return reply.status(404).send({ success: false, error: 'Device not found' });
        try {
            const runtime = await getOrCreateRuntime(runtimeManager, context);
            const state = await runtime.performPhysicalIrrigationAction(parsed.data.action);
            return { success: true, state, delivery: runtime.connected ? 'publish_requested' : 'queued_offline' };
        } catch (error) {
            return reply.status(409).send({ success: false, error: {
                code: 'PHYSICAL_PUMP_ACTION_REJECTED', message: error instanceof Error ? error.message : 'Pump action failed',
            } });
        }
    });

    app.post('/api/devices/:mac/physical-siren', async (request, reply) => {
        const mac = normalizeMac((request.params as { mac: string }).mac);
        const parsed = physicalSirenActionSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.status(400).send({ success: false, error: parsed.error.flatten() });
        }
        const context = await getDeviceContext(mac);
        if (!context) return reply.status(404).send({ success: false, error: 'Device not found' });
        try {
            const runtime = await getOrCreateRuntime(runtimeManager, context);
            const state = await runtime.performPhysicalSirenAction(
                parsed.data.action,
                parsed.data.duration_seconds ?? 0,
            );
            return {
                success: true,
                state,
                delivery: runtime.connected ? 'publish_requested' : 'stored_offline',
            };
        } catch (error) {
            return reply.status(409).send({
                success: false,
                error: {
                    code: 'PHYSICAL_SIREN_ACTION_REJECTED',
                    message: error instanceof Error ? error.message : 'Physical siren action failed',
                },
            });
        }
    });

    app.post('/api/devices/:mac/physical-keypad', async (request, reply) => {
        const mac = normalizeMac((request.params as { mac: string }).mac);
        const parsed = physicalKeypadSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.status(400).send({ success: false, error: parsed.error.flatten() });
        }
        const context = await getDeviceContext(mac);
        if (!context) return reply.status(404).send({ success: false, error: 'Device not found' });
        try {
            const runtime = await getOrCreateRuntime(runtimeManager, context);
            const state = await runtime.pressEntranceKey(parsed.data.key);
            return {
                success: true,
                state,
                entrance: runtime.entranceStatus,
                delivery: runtime.connected ? 'publish_requested' : 'queued_offline',
            };
        } catch (error) {
            return reply.status(409).send({
                success: false,
                error: {
                    code: 'PHYSICAL_KEYPAD_ACTION_REJECTED',
                    message: error instanceof Error ? error.message : 'Physical keypad action failed',
                },
            });
        }
    });

    app.post('/api/devices/:mac/physical-door', async (request, reply) => {
        const mac = normalizeMac((request.params as { mac: string }).mac);
        const parsed = physicalDoorSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.status(400).send({ success: false, error: parsed.error.flatten() });
        }
        const context = await getDeviceContext(mac);
        if (!context) return reply.status(404).send({ success: false, error: 'Device not found' });
        try {
            const runtime = await getOrCreateRuntime(runtimeManager, context);
            const state = await runtime.setEntranceDoorPosition(
                parsed.data.angle_degrees,
                parsed.data.sensor_state,
            );
            return {
                success: true,
                state,
                entrance: runtime.entranceStatus,
                delivery: runtime.connected ? 'publish_requested' : 'queued_offline',
            };
        } catch (error) {
            return reply.status(409).send({
                success: false,
                error: {
                    code: 'PHYSICAL_DOOR_ACTION_REJECTED',
                    message: error instanceof Error ? error.message : 'Physical door action failed',
                },
            });
        }
    });

    app.post('/api/devices/:mac/reveal-secret', async (request, reply) => {
        const mac = normalizeMac((request.params as { mac: string }).mac);
        const device = await getMongoDb().collection<SimulatedDeviceRecord>('simulated_devices')
            .findOne({ mac });
        if (!device) return reply.status(404).send({ success: false, error: 'Device not found' });
        const secretKey = decrypt(device.secret.iv, device.secret.encrypted, device.secret.authTag);
        await recordDeviceAction(
            device,
            'security.device_secret_revealed',
            'Virtual device secret was revealed',
        );
        reply.header('Cache-Control', 'no-store');
        return {
            success: true,
            device: { mac, secret_key: secretKey, product_id: device.product_id },
        };
    });
};

/** Digits compare as numbers ("2-1" before "10-1"); matches the registry index. */
export const NATURAL_NAME_ORDER = { locale: 'en', numericOrdering: true } as const;

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The registry copy lags by up to REGISTRY_STATE_FLUSH_INTERVAL_MS; a live runtime is authoritative. */
const withLiveState = <T extends SimulatedDeviceRecord>(
    device: T,
    runtime: ReturnType<RuntimeManager['getDevice']>,
): T => (runtime ? {
    ...device,
    state_snapshot: runtime.stateSnapshot,
    runtime_state: runtime.liveRuntimeState,
    last_telemetry: runtime.lastTelemetry || device.last_telemetry,
} : device);

const normalizeMac = (value: string): string =>
    decodeURIComponent(value).trim().toUpperCase();

const parseLimit = (value?: string): number =>
    Math.min(Math.max(Number(value) || 100, 1), env.MAX_PAGE_SIZE);

const deviceExists = async (mac: string): Promise<boolean> =>
    Boolean(await getMongoDb().collection('simulated_devices').findOne(
        { mac },
        { projection: { _id: 1 } },
    ));

/**
 * The system's view of a run device, read as its simulated user through the
 * public API (what the user's app would show). A factory device belongs to a
 * real account the Simulator cannot act as: its system view is not shown.
 */
const userTokenFor = async (device: Pick<SimulatedDeviceRecord, 'origin' | 'simulator_user_id' | 'provisioning_state'>) => {
    if (device.origin === 'factory' || !device.simulator_user_id || device.provisioning_state !== 'claimed') return null;
    return accessTokenFor(device.simulator_user_id).catch(() => null);
};

const loadBackendShadow = async (device: SimulatedDeviceRecord) => {
    const token = await userTokenFor(device);
    return token ? apiGateway.deviceState(token, device.mac).catch(() => null) as Promise<Record<string, unknown> | null> : null;
};

/** The last packet the virtual device published (it keeps no history; the system does). */
const loadTelemetry = (manager: RuntimeManager, mac: string): Record<string, unknown>[] => {
    const packet = manager.getDevice(mac)?.lastTelemetryPacket;
    return packet ? [packet] : [];
};

/** Commands the device received and what it answered, from the Simulator's own event log. */
const loadOperations = async (mac: string, limit: number) => {
    const rows = await getMongoDb().collection('simulator_events')
        .find({ mac, type: { $in: ['device.operation_applied', 'device.operation_rejected'] } })
        .sort({ created_at: -1 })
        .limit(limit)
        .toArray();
    return rows.map((row) => {
        const data = (row.data ?? {}) as Record<string, unknown>;
        const applied = row.type === 'device.operation_applied';
        return {
            id: String(data.operation_id ?? row._id),
            mac,
            status: applied ? 'succeeded' : 'rejected',
            instance_id: String(data.instance_id ?? ''),
            operation_name: String(data.operation_name ?? ''),
            input: (data.input ?? {}) as Record<string, unknown>,
            reason_code: applied ? null : String(data.reason_code ?? 'DEVICE_OPERATION_REJECTED'),
            accepted_at: row.created_at,
            completed_at: row.created_at,
            created_at: row.created_at,
            updated_at: row.created_at,
        };
    });
};

const loadEvents = async (mac: string, limit: number) =>
    getMongoDb().collection('simulator_events')
        .find({ mac })
        .sort({ created_at: -1 })
        .limit(limit)
        .toArray();

/** Physical events (door, keypad…) as the system stored them, read as the device's owner. */
const loadDeviceEvents = async (device: SimulatedDeviceRecord, limit: number) => {
    const token = await userTokenFor(device);
    return token ? apiGateway.deviceEvents(token, device.mac, limit).catch(() => []) : [];
};

const loadVirtualAccessPin = async (mac: string): Promise<string | undefined> => {
    const device = await getMongoDb().collection<SimulatedDeviceRecord>('simulated_devices')
        .findOne({ mac });
    return device ? ensureAccessPin(device) : undefined;
};

const findManagedEntrancePatch = (
    product: Awaited<ReturnType<typeof resolveDeviceProduct>>,
    patch: DeviceStatePatch,
): string | null => {
    const firmwareManagedCapabilities = new Set([
        'door_lock',
        'door_position',
        'pin_authentication',
        'keypad_input',
        'irrigation_pump',
    ]);
    for (const instanceId of Object.keys(patch.instances || {})) {
        const instance = product.capability_instances.find(
            (candidate) => candidate.instance_id === instanceId,
        );
        if (instance && firmwareManagedCapabilities.has(instance.capability_id)) {
            return instanceId;
        }
    }
    return null;
};

export const getDeviceContext = async (mac: string): Promise<{
    device: SimulatedDeviceRecord;
    run: SimulationRun;
} | null> => {
    const device = await getMongoDb().collection<SimulatedDeviceRecord>('simulated_devices')
        .findOne({ mac });
    if (!device) return null;
    // Manufactured devices belong to no run; the factory supplies their settings.
    if (device.origin === 'factory') return { device, run: factoryRunContext() };
    const run = await getMongoDb().collection<SimulationRun>('simulation_runs')
        .findOne({ id: device.run_id });
    if (!run) return null;
    return { device, run };
};

const requireClaimedDevice = async (mac: string, reply: any) => {
    const context = await getDeviceContext(mac);
    if (!context) {
        reply.status(404).send({ success: false, error: 'Device not found' });
        return null;
    }
    // A factory device can always be switched on: unclaimed, it waits in pairing mode.
    if (context.device.origin === 'factory') return context;
    if (context.device.provisioning_state === 'unpaired') {
        // Claimed again by its simulated user (with the app, using the revealed credential)?
        const token = await accessTokenFor(context.device.simulator_user_id).catch(() => null);
        const owned = token
            ? (await apiGateway.listDevices(token).catch(() => []))
                .find((row) => row.mac === mac && row.owner_id === context.device.simulator_user_id)
            : undefined;
        if (owned) {
            context.device.provisioning_state = 'claimed';
            context.device.device_id = owned.id;
            await getMongoDb().collection<SimulatedDeviceRecord>('simulated_devices').updateOne(
                { mac },
                { $set: { provisioning_state: 'claimed', device_id: owned.id, updated_at: new Date() } },
            );
        }
    }
    if (context.device.provisioning_state !== 'claimed') {
        reply.status(409).send({ success: false, error: 'Device is not claimed' });
        return null;
    }
    return context;
};

export const getOrCreateRuntime = async (
    manager: RuntimeManager,
    context: { device: SimulatedDeviceRecord; run: SimulationRun },
) => {
    if (context.device.origin === 'factory') return getFactoryService().runtimeFor(context.device);
    const product = await resolveDeviceProduct(context.device);
    return manager.addDevice(
        context.run.id,
        context.device.mac,
        product,
        context.run.config.telemetry_interval * 1000,
        context.run.config.telemetry_jitter_percent ?? 10,
        context.run.config.startup_ramp_seconds ?? 30,
        context.device.seq || 0,
        context.device.state_snapshot,
        assignmentFromClaim(context.device),
        await ensureAccessPin(context.device),
        context.device.irrigation_session,
    );
};

const persistOfflineState = async (mac: string, state: DeviceState): Promise<void> => {
    await getMongoDb().collection<SimulatedDeviceRecord>('simulated_devices').updateOne(
        { mac },
        { $set: { state_snapshot: state, updated_at: new Date() } },
    );
};

const recordDeviceAction = async (
    device: SimulatedDeviceRecord,
    type: string,
    message: string,
    data?: Record<string, unknown>,
): Promise<void> => {
    await recordSimulatorEvent({
        type,
        severity: type.startsWith('security.') ? 'warning' : 'info',
        run_id: device.run_id,
        ...(device.simulator_user_id ? { account_id: device.simulator_user_id } : {}),
        mac: device.mac,
        message,
        ...(data ? { data } : {}),
    });
};

export default devicesRoutes;
