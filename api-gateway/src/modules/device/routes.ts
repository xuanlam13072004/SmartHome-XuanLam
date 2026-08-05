import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { typedRouteConfig } from '../../plugins/validation';
import {
    claimSchema,
    credentialListSchema,
    deviceStateSchema,
    operationSchema,
    replaceCredentialSchema,
    resourceSessionSchema,
    resourceSessionStatusSchema,
    unpairSchema,
    updateDeviceSchema,
} from './schemas';
import {
    claimDevice,
    createDeviceOperation,
    createDeviceResourceSession,
    getDeviceResourceSession,
    getDeviceState,
    listDeviceCredentials,
    listDevices,
    replaceDeviceCredential,
    unpairDevice,
    updateDeviceName,
} from './service';

function hasRecentReauthentication(app: FastifyInstance, request: any) {
    const token = request.headers['x-reauth-token'];
    if (typeof token !== 'string') return false;
    try {
        const confirmation = app.jwt.verify(token) as any;
        return confirmation.purpose === 'reauth'
            && confirmation.userId === request.user.userId;
    } catch {
        return false;
    }
}

/**
 * Device routes
 * - Claim, ownership, operation, protected resource and credential APIs
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

    app.post('/devices/:mac/operations', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({
            zodSchema: operationSchema,
            rateLimit: {
                max: 30,
                timeWindow: '1 minute',
            },
        }),
    }, async (request) => {
        const params = request.params as any;
        const body = request.body as any;
        const reauthenticated = hasRecentReauthentication(app, request);
        const result = await createDeviceOperation(
            app,
            {
                mac: params.mac,
                instance_id: body.instance_id,
                operation_name: body.operation_name,
                input: body.input,
                idempotency_key: body.idempotency_key,
                expected_state_version: body.expected_state_version,
                reauthenticated,
            },
            (request.user as any).userId
        );
        return { success: true, ...result };
    });

    app.post('/devices/:mac/resources/:instanceId/:resourceId/sessions', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({
            zodSchema: resourceSessionSchema,
            rateLimit: { max: 20, timeWindow: '1 minute' },
        }),
    }, async (request) => {
        const params = request.params as any;
        const result = await createDeviceResourceSession(app, {
            mac: params.mac,
            instance_id: params.instanceId,
            resource_id: params.resourceId,
            reauthenticated: hasRecentReauthentication(app, request),
        }, (request.user as any).userId);
        return { success: true, session: result };
    });

    app.get('/devices/:mac/resource-sessions/:sessionId', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({ zodSchema: resourceSessionStatusSchema }),
    }, async (request) => {
        const params = request.params as any;
        const session = await getDeviceResourceSession(
            app,
            params.mac,
            params.sessionId,
            (request.user as any).userId,
        );
        return { success: true, session };
    });

    app.put('/devices/:mac/credentials/:instanceId/:credentialName', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({
            zodSchema: replaceCredentialSchema,
            rateLimit: { max: 5, timeWindow: '1 minute' },
        }),
    }, async (request) => {
        const params = request.params as any;
        const body = request.body as any;
        const result = await replaceDeviceCredential(app, {
            mac: params.mac,
            instance_id: params.instanceId,
            credential_name: params.credentialName,
            material: body.material,
            label: body.label,
            idempotency_key: body.idempotency_key,
            reauthenticated: hasRecentReauthentication(app, request),
        }, (request.user as any).userId);
        return { success: true, ...result };
    });

    app.get('/devices/:mac/credentials', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({ zodSchema: credentialListSchema }),
    }, async (request) => {
        const params = request.params as any;
        const credentials = await listDeviceCredentials(
            app,
            params.mac,
            (request.user as any).userId,
        );
        return { success: true, credentials };
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
        const products = app.catalog.getAllProducts();
        return { success: true, catalog_revision: app.catalog.catalogVersion, products };
    });

    app.get('/products/:id', async (request, reply) => {
        const params = request.params as any;
        const product = app.catalog.getProduct(params.id);
        if (!product) {
            reply.status(404);
            return { success: false, error: 'Product not found' };
        }
        return { success: true, product };
    });
};

export default deviceRoutes;
