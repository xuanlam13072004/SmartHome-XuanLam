import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env';
import { getFactoryService } from '../../factory/service';

const manufactureSchema = z.object({
    product_id: z.string().trim().regex(/^prod_[a-z0-9_]+$/),
    quantity: z.number().int().min(1).max(env.FACTORY_MAX_BATCH_SIZE),
    power_on: z.boolean().default(true),
    note: z.string().trim().max(120).optional(),
}).strict();

const powerSchema = z.object({ on: z.boolean() }).strict();

const sendError = (reply: any, error: unknown) => {
    const typed = error as Error & { statusCode?: number; code?: string };
    if (!typed.statusCode || typed.statusCode >= 500) throw error;
    return reply.status(typed.statusCode).send({
        success: false,
        error: { code: typed.code || 'REQUEST_ERROR', message: typed.message },
    });
};

const macParam = (request: { params: unknown }): string =>
    decodeURIComponent((request.params as { mac: string }).mac).trim().toUpperCase();

/** Simulator factory: blank devices with QR labels, claimable from the app. */
const factoryRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
    const factory = getFactoryService(app.log);

    app.get('/api/factory/batches', async () => ({
        success: true,
        max_batch_size: env.FACTORY_MAX_BATCH_SIZE,
        batches: await factory.listBatches(),
    }));

    app.post('/api/factory/batches', async (request, reply) => {
        const parsed = manufactureSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.status(400).send({ success: false, error: parsed.error.flatten() });
        }
        try {
            const result = await factory.manufacture(parsed.data);
            reply.header('Cache-Control', 'no-store');
            return reply.status(201).send({ success: true, ...result });
        } catch (error) {
            return sendError(reply, error);
        }
    });

    app.post('/api/factory/batches/:id/scrap-unclaimed', async (request, reply) => {
        try {
            const id = decodeURIComponent((request.params as { id: string }).id);
            return { success: true, ...(await factory.scrapUnclaimed(id)) };
        } catch (error) {
            return sendError(reply, error);
        }
    });

    app.get('/api/factory/devices', async (request, reply) => {
        const query = request.query as { batch_id?: string; include_pairing?: string };
        const includePairing = query.include_pairing === '1' || query.include_pairing === 'true';
        if (includePairing) reply.header('Cache-Control', 'no-store');
        return {
            success: true,
            devices: await factory.listDevices({
                batchId: query.batch_id || undefined,
                includePairing,
            }),
        };
    });

    app.post('/api/factory/devices/:mac/power', async (request, reply) => {
        const parsed = powerSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.status(400).send({ success: false, error: parsed.error.flatten() });
        }
        try {
            const mac = macParam(request);
            if (parsed.data.on) {
                const runtime = await factory.powerOn(mac);
                return {
                    success: true,
                    runtime_state: runtime?.awaitingClaim ? 'awaiting_claim' : runtime?.connected ? 'online' : 'offline',
                };
            }
            await factory.powerOff(mac);
            return { success: true, runtime_state: 'offline' };
        } catch (error) {
            return sendError(reply, error);
        }
    });

    app.post('/api/factory/devices/:mac/scrap', async (request, reply) => {
        try {
            await factory.scrap(macParam(request));
            return { success: true };
        } catch (error) {
            return sendError(reply, error);
        }
    });

    /** QR label (pairing payload) of any simulated device. */
    app.get('/api/devices/:mac/pairing', async (request, reply) => {
        try {
            const pairing = await factory.pairing(macParam(request));
            reply.header('Cache-Control', 'no-store');
            return { success: true, pairing };
        } catch (error) {
            return sendError(reply, error);
        }
    });
};

export default factoryRoutes;
