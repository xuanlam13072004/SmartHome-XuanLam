import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { typedRouteConfig } from '../../plugins/validation';
import { httpError } from '../../utils/httpError';
import { pushConfigured } from './fcm';
import { pushToAccounts, registerPushToken, removePushToken } from './service';

const tokenField = z.string().min(20).max(4096).regex(/^[A-Za-z0-9_:\-.]+$/);

const registerSchema = z.object({
    body: z.object({ token: tokenField, platform: z.enum(['android', 'ios']) }).strict(),
});
const removeSchema = z.object({ body: z.object({ token: tokenField }).strict() });

const userOf = (request: FastifyRequest) => request.user as { userId: string; sid: string };

/** The phone's FCM token for the signed-in session, and a test push. */
const pushRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
    app.put('/me/push-tokens', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({ zodSchema: registerSchema, rateLimit: { max: 20, timeWindow: '1 minute' } }),
    }, async (request) => {
        const body = request.body as { token: string; platform: 'android' | 'ios' };
        const user = userOf(request);
        await registerPushToken(app.pg, { accountId: user.userId, sessionId: user.sid, ...body });
        return { success: true, push_enabled: pushConfigured() };
    });

    app.delete('/me/push-tokens', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({ zodSchema: removeSchema, rateLimit: { max: 20, timeWindow: '1 minute' } }),
    }, async (request) => {
        await removePushToken(app.pg, userOf(request).userId, (request.body as { token: string }).token);
        return { success: true };
    });

    app.post('/me/push-tokens/test', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({ rateLimit: { max: 3, timeWindow: '1 minute' } }),
    }, async (request) => {
        if (!pushConfigured()) {
            throw httpError(503, 'PUSH_UNAVAILABLE', 'Máy chủ chưa bật thông báo đẩy.');
        }
        const stats = await pushToAccounts({ pg: app.pg, log: app.log }, [userOf(request).userId], {
            title: 'Thông báo thử', body: 'Thông báo đẩy đã hoạt động trên điện thoại này.',
            route: '/profile/notifications', channel: 'general', data: { kind: 'test' },
        });
        if (stats.sent === 0) {
            throw httpError(409, 'PUSH_NO_DEVICE', 'Chưa gửi được: điện thoại này chưa đăng ký nhận thông báo.');
        }
        return { success: true, sent: stats.sent };
    });
};

export default pushRoutes;
