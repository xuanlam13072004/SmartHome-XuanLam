import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { typedRouteConfig } from '../../plugins/validation';
import {
    changePasswordSchema,
    deleteAccountSchema,
    sessionParamsSchema,
    updateProfileSchema,
} from './schemas';
import {
    changePassword,
    deleteAccount,
    listSessions,
    revokeOtherSessions,
    revokeSession,
} from './security';
import { getAccountOverview, updateProfile } from './service';

export function accountIdOf(request: FastifyRequest): string {
    return (request.user as { userId: string }).userId;
}

/** Login session of the access token; `authenticate` guarantees it exists. */
export function sessionIdOf(request: FastifyRequest): string {
    return (request.user as { sid: string }).sid;
}

/**
 * Account center ("Cá nhân"): the signed-in user's own profile, security and
 * settings. Every route acts only on the caller's account.
 */
const accountRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
    app.get('/me', {
        preHandler: [app.authenticate],
    }, async (request) => ({
        success: true,
        ...(await getAccountOverview(app, accountIdOf(request))),
    }));

    app.patch('/me', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({
            zodSchema: updateProfileSchema,
            rateLimit: { max: 10, timeWindow: '1 minute' },
        }),
    }, async (request) => ({
        success: true,
        user: await updateProfile(app, accountIdOf(request), request.body as { full_name: string }),
    }));

    // ── Security ────────────────────────────────────────────────────────────

    app.post('/me/password', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({
            zodSchema: changePasswordSchema,
            rateLimit: { max: 5, timeWindow: '1 minute' },
        }),
    }, async (request) => ({
        success: true,
        ...(await changePassword(
            app,
            accountIdOf(request),
            sessionIdOf(request),
            request.body as { current_password: string; new_password: string },
        )),
    }));

    app.get('/me/sessions', {
        preHandler: [app.authenticate],
    }, async (request) => ({
        success: true,
        sessions: await listSessions(app, accountIdOf(request), sessionIdOf(request)),
    }));

    app.delete('/me/sessions/:sessionId', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({
            zodSchema: sessionParamsSchema,
            rateLimit: { max: 20, timeWindow: '1 minute' },
        }),
    }, async (request) => {
        const { sessionId } = request.params as { sessionId: string };
        await revokeSession(app, accountIdOf(request), sessionId);
        return { success: true };
    });

    app.post('/me/sessions/revoke-others', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({
            rateLimit: { max: 10, timeWindow: '1 minute' },
        }),
    }, async (request) => ({
        success: true,
        signed_out_sessions: await revokeOtherSessions(app, accountIdOf(request), sessionIdOf(request)),
    }));

    app.delete('/me', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({
            zodSchema: deleteAccountSchema,
            rateLimit: { max: 3, timeWindow: '1 minute' },
        }),
    }, async (request) => {
        await deleteAccount(app, accountIdOf(request), (request.body as { password: string }).password);
        return { success: true };
    });
};

export default accountRoutes;
