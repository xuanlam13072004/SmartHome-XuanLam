import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { claimSchema, commandSchema, deviceStateSchema, unpairSchema } from './schemas';
import { claimDevice, getDeviceState, listDevices, sendDeviceCommand, unpairDevice } from './service';

/**
 * Device routes
 * - Claim / unpair / list / send command
 */
const deviceRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
    app.get('/devices', {
        preHandler: [app.authenticate],
    }, async (request) => {
        const devices = await listDevices(app, request.user.userId);
        return { success: true, devices };
    });

    app.post('/devices/claim', {
        preHandler: [app.authenticate],
        validationSchema: claimSchema,
    }, async (request) => {
        const body = request.body as any;
        const device = await claimDevice(app, body, request.user.userId);
        return { success: true, device };
    });

    app.delete('/devices/:mac', {
        preHandler: [app.authenticate],
        validationSchema: unpairSchema,
    }, async (request) => {
        const params = request.params as any;
        const result = await unpairDevice(app, params.mac, request.user.userId);
        return { success: true, ...result };
    });

    app.post('/devices/:mac/commands', {
        preHandler: [app.authenticate],
        validationSchema: commandSchema,
    }, async (request) => {
        const params = request.params as any;
        const body = request.body as any;
        const result = await sendDeviceCommand(
            app,
            { mac: params.mac, action: body.action, payload: body.payload },
            request.user.userId
        );
        return { success: true, ...result };
    });

    app.get('/devices/:mac/state', {
        preHandler: [app.authenticate],
        validationSchema: deviceStateSchema,
    }, async (request) => {
        const params = request.params as any;
        const state = await getDeviceState(app, params.mac, request.user.userId);
        return { success: true, state };
    });
};

export default deviceRoutes;
