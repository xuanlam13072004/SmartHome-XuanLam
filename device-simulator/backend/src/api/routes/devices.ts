import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env';
import type { SimulatedDeviceRecord } from '../../domain/registry';
import type { SimulationRun } from '../../domain/simulation-run';
import {
    getMainMongoDb,
    getMongoDb,
} from '../../infrastructure/mongodb/client';
import { getRuntimeManager } from '../../runtime/manager';
import { decrypt } from '../../security/crypto';
import { recordSimulatorEvent } from '../../events/service';

const deviceProjection = { secret: 0 } as const;

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
        const limit = Math.min(Math.max(Number(query.limit) || 100, 1), env.MAX_PAGE_SIZE);

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

        const telemetry = await getMainMongoDb().collection(env.MAIN_MONGO_TELEMETRY_COLLECTION)
            .find({ 'metadata.device_id': mac })
            .sort({ timestamp: -1 })
            .limit(100)
            .toArray();
        const events = await getMongoDb().collection('simulator_events')
            .find({ mac })
            .sort({ created_at: -1 })
            .limit(100)
            .toArray();
        return { success: true, device, telemetry, events };
    });

    app.post('/api/devices/:mac/connect', async (request, reply) => {
        const mac = normalizeMac((request.params as { mac: string }).mac);
        const context = await getDeviceContext(mac);
        if (!context) return reply.status(404).send({ success: false, error: 'Device not found' });
        if (context.device.provisioning_state !== 'claimed') {
            return reply.status(409).send({ success: false, error: 'Device is not claimed' });
        }
        await getMongoDb().collection<SimulatedDeviceRecord>('simulated_devices').updateOne(
            { mac },
            { $set: { desired_state: 'online', updated_at: new Date() } },
        );
        const runtime = runtimeManager.addDevice(
            context.run.id,
            mac,
            context.device.product_id,
            context.run.config.telemetry_interval * 1000,
            context.run.config.telemetry_jitter_percent ?? 10,
            context.run.config.startup_ramp_seconds ?? 30,
            context.device.seq || 0,
            context.device.state_snapshot,
        );
        await runtime.connect();
        return { success: true, runtime_state: 'online' };
    });

    app.post('/api/devices/:mac/disconnect', async (request, reply) => {
        const mac = normalizeMac((request.params as { mac: string }).mac);
        const device = await getMongoDb().collection<SimulatedDeviceRecord>('simulated_devices').findOne({ mac });
        if (!device) return reply.status(404).send({ success: false, error: 'Device not found' });
        await getMongoDb().collection<SimulatedDeviceRecord>('simulated_devices').updateOne(
            { mac },
            { $set: { desired_state: 'offline', updated_at: new Date() } },
        );
        await runtimeManager.removeDevice(mac);
        return { success: true, runtime_state: 'offline' };
    });

    app.post('/api/devices/:mac/telemetry', async (request, reply) => {
        const mac = normalizeMac((request.params as { mac: string }).mac);
        const runtime = runtimeManager.getDevice(mac);
        if (!runtime?.connected) {
            return reply.status(409).send({
                success: false,
                error: 'Device must be online before sending telemetry',
            });
        }
        await runtime.publishNow();
        return reply.status(202).send({ success: true });
    });

    app.post('/api/devices/:mac/reveal-secret', async (request, reply) => {
        const mac = normalizeMac((request.params as { mac: string }).mac);
        const device = await getMongoDb().collection<SimulatedDeviceRecord>('simulated_devices').findOne({ mac });
        if (!device) return reply.status(404).send({ success: false, error: 'Device not found' });
        const secretKey = decrypt(device.secret.iv, device.secret.encrypted, device.secret.authTag);
        await recordSimulatorEvent({
            type: 'security.device_secret_revealed',
            severity: 'warning',
            run_id: device.run_id,
            account_id: device.simulator_user_id,
            mac,
            message: 'Virtual device secret was revealed',
        });
        reply.header('Cache-Control', 'no-store');
        return {
            success: true,
            device: {
                mac,
                secret_key: secretKey,
                product_id: device.product_id,
            },
        };
    });
};

const normalizeMac = (value: string): string => decodeURIComponent(value).trim().toUpperCase();

const getDeviceContext = async (mac: string): Promise<{
    device: SimulatedDeviceRecord;
    run: SimulationRun;
} | null> => {
    const device = await getMongoDb().collection<SimulatedDeviceRecord>('simulated_devices').findOne({ mac });
    if (!device) return null;
    const run = await getMongoDb().collection<SimulationRun>('simulation_runs').findOne({ id: device.run_id });
    if (!run) return null;
    return { device, run };
};

export default devicesRoutes;
