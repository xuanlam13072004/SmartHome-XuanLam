import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { typedRouteConfig } from '../../plugins/validation';
import { listActivity } from '../activity/service';
import { pageQuerySchema, preferencesSchema } from './schemas';
import {
    getBadges,
    getPreferences,
    listNotifications,
    markNotificationsSeen,
    updatePreferences,
} from './service';

const accountIdOf = (request: FastifyRequest) => (request.user as { userId: string }).userId;
type Page = { before?: string; limit: number };

/** Notification center, its settings, badges and the activity history. */
const notificationRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
    app.get('/me/notifications', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({ zodSchema: pageQuerySchema }),
    }, async (request) => ({
        success: true,
        ...(await listNotifications(app, accountIdOf(request), request.query as Page)),
    }));

    app.post('/me/notifications/seen', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({ rateLimit: { max: 60, timeWindow: '1 minute' } }),
    }, async (request) => {
        await markNotificationsSeen(app, accountIdOf(request));
        return { success: true };
    });

    app.get('/me/badges', {
        preHandler: [app.authenticate],
    }, async (request) => ({ success: true, ...(await getBadges(app, accountIdOf(request))) }));

    app.get('/me/preferences', {
        preHandler: [app.authenticate],
    }, async (request) => ({ success: true, ...(await getPreferences(app, accountIdOf(request))) }));

    app.patch('/me/preferences', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({ zodSchema: preferencesSchema, rateLimit: { max: 30, timeWindow: '1 minute' } }),
    }, async (request) => ({
        success: true,
        ...(await updatePreferences(
            app,
            accountIdOf(request),
            (request.body as { muted_notification_categories: string[] }).muted_notification_categories,
        )),
    }));

    app.get('/me/activity', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({ zodSchema: pageQuerySchema }),
    }, async (request) => ({
        success: true,
        ...(await listActivity(app, accountIdOf(request), request.query as Page)),
    }));
};

export default notificationRoutes;
