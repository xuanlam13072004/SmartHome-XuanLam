import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { typedRouteConfig } from '../../plugins/validation';
import { httpError } from '../../utils/httpError';
import {
    cancelOrder,
    createOrder,
    getOrder,
    handleSepayTransaction,
    listOrders,
    paymentOptions,
    sepayConfigured,
    simulatePayment,
    verifySepayRequest,
} from './service';

const accountIdOf = (request: FastifyRequest) => (request.user as { userId: string }).userId;
const codeOf = (request: FastifyRequest) => String((request.params as { code: string }).code).toUpperCase();

const createOrderSchema = z.object({
    body: z.object({
        plan_code: z.string().min(1).max(32),
        months: z.union([z.literal(1), z.literal(12)]),
    }),
});

/**
 * Payments for assistant plans (docs/architecture/payments.md). The app
 * creates an order, shows its VietQR and watches its status; the bank
 * notification arrives through the SePay webhook.
 */
const paymentRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
    app.get('/payments/options', {
        preHandler: [app.authenticate],
    }, async () => ({ success: true, ...(await paymentOptions(app)) }));

    app.post('/payments/orders', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({ zodSchema: createOrderSchema, rateLimit: { max: 10, timeWindow: '1 hour' } }),
    }, async (request) => ({
        success: true,
        order: await createOrder(app, accountIdOf(request), request.body as { plan_code: string; months: 1 | 12 }),
    }));

    app.get('/payments/orders', {
        preHandler: [app.authenticate],
    }, async (request) => ({ success: true, orders: await listOrders(app, accountIdOf(request)) }));

    // Polled by the app while the QR is on screen.
    app.get('/payments/orders/:code', {
        preHandler: [app.authenticate],
        config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    }, async (request) => ({ success: true, order: await getOrder(app, accountIdOf(request), codeOf(request)) }));

    app.post('/payments/orders/:code/cancel', {
        preHandler: [app.authenticate],
        config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    }, async (request) => {
        await cancelOrder(app, accountIdOf(request), codeOf(request));
        return { success: true };
    });

    // PAYMENT_MODE=mock only: "pays" without money, for testing.
    app.post('/payments/orders/:code/simulate', {
        preHandler: [app.authenticate],
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    }, async (request) => ({ success: true, order: await simulatePayment(app, accountIdOf(request), codeOf(request)) }));

    // SePay → here. Its own context keeps the raw body, which the HMAC signature covers.
    await app.register(async (hook) => {
        hook.removeContentTypeParser('application/json');
        hook.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 64 * 1024 }, (request, body, done) => {
            (request as FastifyRequest & { rawBody?: string }).rawBody = body as string;
            try {
                done(null, JSON.parse(body as string));
            } catch {
                done(httpError(400, 'PAYMENT_PAYLOAD_INVALID', 'Invalid JSON'), undefined);
            }
        });
        hook.post('/payments/sepay/webhook', {
            config: { rateLimit: { max: 300, timeWindow: '1 minute' } },
        }, async (request, reply) => {
            if (!sepayConfigured()) throw httpError(503, 'PAYMENT_WEBHOOK_DISABLED', 'Webhook is not configured');
            const raw = (request as FastifyRequest & { rawBody?: string }).rawBody ?? '';
            if (!verifySepayRequest(request.headers as Record<string, unknown>, raw)) {
                return reply.status(401).send({ success: false, message: 'Invalid signature' });
            }
            if (!request.body || typeof request.body !== 'object') {
                throw httpError(400, 'PAYMENT_PAYLOAD_INVALID', 'Invalid payload');
            }
            await handleSepayTransaction(app, request.body as Record<string, any>);
            // SePay retries until it sees this.
            return { success: true };
        });
    });
};

export default paymentRoutes;
