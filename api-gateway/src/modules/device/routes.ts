import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { typedRouteConfig } from '../../plugins/validation';
import { claimSchema, commandSchema, deviceStateSchema, unpairSchema, updateDeviceSchema } from './schemas';
import { claimDevice, getDeviceState, listDevices, sendDeviceCommand, unpairDevice, updateDeviceName } from './service';

/**
 * Device routes
 * - Claim / unpair / list / send command
 */
const deviceRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
    app.get('/devices', {
        preHandler: [app.authenticate],
    }, async (request) => {
        const devices = await listDevices(app, (request.user as any).userId);
        return { success: true, devices };
    });

    app.post('/devices/claim', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({
            zodSchema: claimSchema,
            rateLimit: {
                max: 10,
                timeWindow: '1 minute',
            },
        }),
    }, async (request) => {
        const body = request.body as any;
        const device = await claimDevice(app, body, (request.user as any).userId);
        return { success: true, device };
    });

    app.delete('/devices/:mac', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({
            zodSchema: unpairSchema,
        }),
    }, async (request) => {
        const params = request.params as any;
        const result = await unpairDevice(app, params.mac, (request.user as any).userId);
        return { success: true, ...result };
    });

    app.post('/devices/:mac/commands', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({
            zodSchema: commandSchema,
            rateLimit: {
                max: 30,
                timeWindow: '1 minute',
            },
        }),
    }, async (request) => {
        const params = request.params as any;
        const body = request.body as any;
        const result = await sendDeviceCommand(
            app,
            { mac: params.mac, action: body.action, instance: body.instance, payload: body.payload },
            (request.user as any).userId
        );
        return { success: true, ...result };
    });

    app.get('/devices/:mac/state', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({
            zodSchema: deviceStateSchema,
        }),
    }, async (request) => {
        const params = request.params as any;
        const state = await getDeviceState(app, params.mac, (request.user as any).userId);
        return { success: true, state };
    });

    app.patch('/devices/:mac', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({
            zodSchema: updateDeviceSchema,
        }),
    }, async (request) => {
        const params = request.params as any;
        const body = request.body as any;
        const device = await updateDeviceName(app, params.mac, body.name, (request.user as any).userId);
        return { success: true, device };
    });

    app.get('/products', async () => {
        const products = app.catalogCache.getAllProducts();
        return { success: true, products };
    });

    app.get('/products/:id', async (request, reply) => {
        const params = request.params as any;
        const product = app.catalogCache.getProduct(params.id);
        if (!product) {
            reply.status(404);
            return { success: false, error: 'Product not found' };
        }
        return { success: true, product };
    });
};

export default deviceRoutes;
