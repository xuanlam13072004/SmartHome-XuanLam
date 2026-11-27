import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env';
import { ipKey } from '../../plugins/rateLimit';
import { typedRouteConfig } from '../../plugins/validation';
import { httpError } from '../../utils/httpError';
import { adminKeyMatches, cameThroughTunnel } from '../admin/guard';
import { createFactoryDevices, factoryDeviceStatus, retireFactoryDevices } from './service';

/**
 * API xưởng (docs/architecture/mqtt-security.md): how a factory registers the
 * devices it makes and retires the ones that were never sold or were given
 * back. Used by the Device Simulator's virtual factory; a real factory would
 * use the same calls. Never reachable through Cloudflare Tunnel; each call
 * carries FACTORY_API_KEY in X-Factory-Key (no key configured = no API).
 */

export const FACTORY_KEY_HEADER = 'x-factory-key';
const WRONG_KEYS_PER_MINUTE = 20;

const mac = z.string().regex(/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/);
const uniqueMacs = (max: number) => z.array(mac).min(1).max(max)
    .refine(list => new Set(list).size === list.length, { message: 'MACs must be unique' });

const createSchema = z.object({
    body: z.object({
        devices: z.array(z.object({
            mac,
            product_id: z.string().regex(/^prod_[a-z0-9_]+$/).max(64),
            catalog_revision: z.number().int().min(1),
            firmware_family: z.string().regex(/^[a-z][a-z0-9_]+$/).max(40),
            hardware_revision: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/).nullable().optional(),
            secret_key_hash: z.string().startsWith('$argon2').max(512),
            credential_public_key_pem: z.string().startsWith('-----BEGIN PUBLIC KEY-----').max(4096),
            mqtt_password_hash: z.string().regex(/^[0-9a-f]{64}$/),
            mqtt_salt: z.string().regex(/^[0-9a-f]{32}$/),
        }).strict()).min(1).max(200)
            .refine(list => new Set(list.map(device => device.mac)).size === list.length, { message: 'MACs must be unique' }),
    }).strict(),
});

const statusSchema = z.object({ body: z.object({ macs: uniqueMacs(500) }).strict() });
const retireSchema = z.object({ body: z.object({ macs: uniqueMacs(200) }).strict() });

export default async function factoryRoutes(app: FastifyInstance) {
    const countWrongKey = app.limitBy('factory-key', ipKey, WRONG_KEYS_PER_MINUTE);
    const guard = async (request: FastifyRequest, reply: FastifyReply) => {
        if (!env.FACTORY_API_KEY) throw httpError(404, 'NOT_FOUND', 'Not found');
        if (cameThroughTunnel(request.headers)) {
            throw httpError(403, 'FACTORY_INTERNAL_ONLY', 'The factory API is only reachable from the local network');
        }
        if (!adminKeyMatches(request.headers[FACTORY_KEY_HEADER], env.FACTORY_API_KEY)) {
            await countWrongKey(request, reply);
            throw httpError(401, 'FACTORY_KEY_INVALID', 'Invalid factory key');
        }
    };

    app.post('/factory/devices', {
        preHandler: [guard],
        config: typedRouteConfig({ zodSchema: createSchema }),
    }, async (request) => ({
        success: true,
        devices: await createFactoryDevices(app, (request.body as z.infer<typeof createSchema>['body']).devices),
    }));

    app.post('/factory/devices/status', {
        preHandler: [guard],
        config: typedRouteConfig({ zodSchema: statusSchema }),
    }, async (request) => ({
        success: true,
        devices: await factoryDeviceStatus(app, (request.body as { macs: string[] }).macs),
    }));

    app.post('/factory/devices/retire', {
        preHandler: [guard],
        config: typedRouteConfig({ zodSchema: retireSchema }),
    }, async (request) => ({
        success: true,
        devices: await retireFactoryDevices(app, (request.body as { macs: string[] }).macs),
    }));
}
