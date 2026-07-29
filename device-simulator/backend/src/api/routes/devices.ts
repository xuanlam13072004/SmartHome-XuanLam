import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getProduct } from '../../catalog/loader';
import { env } from '../../config/env';
import type { SimulatedDeviceRecord } from '../../domain/registry';
import type { SimulationRun } from '../../domain/simulation-run';
import { recordSimulatorEvent } from '../../events/service';
import {
    generateInitialState,
    patchDeviceState,
    type DeviceState,
} from '../../generation/telemetry-generator';
import {
    getMainMongoDb,
    getMongoDb,
} from '../../infrastructure/mongodb/client';
import { getPgPool } from '../../infrastructure/postgres/client';
import { getRuntimeManager, type RuntimeManager } from '../../runtime/manager';
import { decrypt } from '../../security/crypto';
import { assignmentFromClaim } from '../../runtime/topology';

const deviceProjection = { secret: 0 } as const;
const statePatchSchema = z.object({
    metrics: z.record(z.string(), z.unknown()).optional(),
    diagnostics: z.record(z.string(), z.unknown()).optional(),
}).strict().refine(
    (value) => value.metrics !== undefined || value.diagnostics !== undefined,
    { message: 'At least one state section is required' },
);

const devicesRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
    const runtimeManager = getRuntimeManager(app.log);

    app.get('/api/devices', async (request) => {
        const query = request.query as {
            run_id?: string;
            user_id?: string;
            limit?: string;
        };
        const filter: Record<string, unknown> = {};
        if (query.run_id) filter.run_id = query.run_id;
        if (query.user_id) filter.simulator_user_id = query.user_id;
        const limit = parseLimit(query.limit);
        const devices = await getMongoDb().collection<SimulatedDeviceRecord>('simulated_devices')
            .find(filter, { projection: deviceProjection })
            .sort({ created_at: -1 })
            .limit(limit)
            .toArray();
        return { success: true, devices };
    });

    app.get('/api/devices/:mac', async (request, reply) => {
        const mac = normalizeMac((request.params as { mac: string }).mac);
        const device = await getMongoDb().collection<SimulatedDeviceRecord>('simulated_devices')
            .findOne({ mac }, { projection: deviceProjection });
        if (!device) return reply.status(404).send({ success: false, error: 'Device not found' });

        const [backendShadow, telemetry, commands, events] = await Promise.all([
            loadBackendShadow(mac),
            loadTelemetry(mac, 100),
            loadCommands(mac, 100),
            loadEvents(mac, 100),
        ]);
        return {
            success: true,
            device,
            backend_shadow: backendShadow,
            telemetry,
            commands,
            events,
        };
    });

    app.get('/api/devices/:mac/telemetry', async (request, reply) => {
        const mac = normalizeMac((request.params as { mac: string }).mac);
        if (!await deviceExists(mac)) {
            return reply.status(404).send({ success: false, error: 'Device not found' });
        }
        const query = request.query as { limit?: string };
        return { success: true, telemetry: await loadTelemetry(mac, parseLimit(query.limit)) };
    });

    app.get('/api/devices/:mac/commands', async (request, reply) => {
        const mac = normalizeMac((request.params as { mac: string }).mac);
        if (!await deviceExists(mac)) {
            return reply.status(404).send({ success: false, error: 'Device not found' });
        }
        const query = request.query as { limit?: string };
        return { success: true, commands: await loadCommands(mac, parseLimit(query.limit)) };
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

        await getMongoDb().collection<SimulatedDeviceRecord>('simulated_devices').updateOne(
            { mac },
            { $set: { desired_state: 'online', updated_at: new Date() } },
        );
        const runtime = getOrCreateRuntime(runtimeManager, context);
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
        const runtime = getOrCreateRuntime(runtimeManager, context);
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
        await getMongoDb().collection<SimulatedDeviceRecord>('simulated_devices').updateOne(
            { mac },
            { $set: { desired_state: 'online', updated_at: new Date() } },
        );
        const runtime = getOrCreateRuntime(runtimeManager, context);
        await runtime.connect();
        await recordDeviceAction(context.device, 'device.reconnected', 'Virtual device reconnected');
        return { success: true, runtime_state: 'online' };
    });

    app.post('/api/devices/:mac/reset-state', async (request, reply) => {
        const mac = normalizeMac((request.params as { mac: string }).mac);
        const context = await getDeviceContext(mac);
        if (!context) return reply.status(404).send({ success: false, error: 'Device not found' });
        const runtime = runtimeManager.getDevice(mac);
        const state = runtime
            ? await runtime.resetState()
            : generateInitialState(getProduct(context.device.product_id));
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
        const runtime = runtimeManager.getDevice(mac);
        const baseState = context.device.state_snapshot
            || generateInitialState(getProduct(context.device.product_id));
        const state = runtime
            ? await runtime.patchState(parsed.data)
            : patchDeviceState(baseState, getProduct(context.device.product_id), parsed.data);
        if (!runtime) await persistOfflineState(mac, state);
        await recordDeviceAction(
            context.device,
            'device.state_updated',
            'Virtual device state manually updated',
            parsed.data,
        );
        return { success: true, state };
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

const normalizeMac = (value: string): string =>
    decodeURIComponent(value).trim().toUpperCase();

const parseLimit = (value?: string): number =>
    Math.min(Math.max(Number(value) || 100, 1), env.MAX_PAGE_SIZE);

const deviceExists = async (mac: string): Promise<boolean> =>
    Boolean(await getMongoDb().collection('simulated_devices').findOne(
        { mac },
        { projection: { _id: 1 } },
    ));

const loadBackendShadow = async (mac: string) =>
    getMainMongoDb().collection(env.MAIN_MONGO_DEVICES_COLLECTION).findOne({ _id: mac } as any);

const loadTelemetry = async (mac: string, limit: number) =>
    getMainMongoDb().collection(env.MAIN_MONGO_TELEMETRY_COLLECTION)
        .find({ 'metadata.device_id': mac })
        .sort({ timestamp: -1 })
        .limit(limit)
        .toArray();

const loadCommands = async (mac: string, limit: number) => {
    const result = await getPgPool().query(
        `SELECT id::text, status, command, error_log, retry_count, event_version,
                created_at, updated_at
         FROM device_commands
         WHERE mac = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [mac, limit],
    );
    return result.rows;
};

const loadEvents = async (mac: string, limit: number) =>
    getMongoDb().collection('simulator_events')
        .find({ mac })
        .sort({ created_at: -1 })
        .limit(limit)
        .toArray();

const getDeviceContext = async (mac: string): Promise<{
    device: SimulatedDeviceRecord;
    run: SimulationRun;
} | null> => {
    const device = await getMongoDb().collection<SimulatedDeviceRecord>('simulated_devices')
        .findOne({ mac });
    if (!device) return null;
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
    if (context.device.provisioning_state !== 'claimed') {
        reply.status(409).send({ success: false, error: 'Device is not claimed' });
        return null;
    }
    return context;
};

const getOrCreateRuntime = (
    manager: RuntimeManager,
    context: { device: SimulatedDeviceRecord; run: SimulationRun },
) => manager.addDevice(
    context.run.id,
    context.device.mac,
    context.device.product_id,
    context.run.config.telemetry_interval * 1000,
    context.run.config.telemetry_jitter_percent ?? 10,
    context.run.config.startup_ramp_seconds ?? 30,
    context.device.seq || 0,
    context.device.state_snapshot,
    assignmentFromClaim(context.device),
);

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
        account_id: device.simulator_user_id,
        mac: device.mac,
        message,
        ...(data ? { data } : {}),
    });
};

export default devicesRoutes;
