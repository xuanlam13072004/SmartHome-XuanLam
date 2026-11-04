import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { typedRouteConfig } from '../../plugins/validation';
import { bodyFieldKey, ipKey, rateLimitLimits } from '../../plugins/rateLimit';
import { loginSchema, logoutSchema, reauthenticateSchema, refreshSchema, registerSchema } from './schemas';
import { loginUser, logoutSession, reauthenticateUser, refreshSession, registerUser } from './service';

/**
 * Auth routes
 * - Định nghĩa các endpoint liên quan đăng nhập / đăng ký / refresh / logout
 * - Chỉ khai báo route + schema cơ bản, logic sẽ tách sang service sau
 */
const authRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
    app.get('/auth/health', async () => {
        return { status: 'ok', module: 'auth' };
    });

    app.post('/auth/register', {
        config: typedRouteConfig({
            zodSchema: registerSchema,
            rateLimit: {
                max: rateLimitLimits.registerPerIp(),
                timeWindow: '1 minute',
                keyGenerator: ipKey,
            },
        }),
    }, async (request) => {
        const body = request.body as any;
        const user = await registerUser(app, body);
        return { success: true, user };
    });

    app.post('/auth/login', {
        // Coarse per-IP ceiling against credential stuffing across many emails.
        preHandler: [app.limitBy('login-ip', ipKey, rateLimitLimits.loginPerIp())],
        config: typedRouteConfig({
            zodSchema: loginSchema,
            // Per-account brute-force protection; users behind one NAT do not block each other.
            rateLimit: {
                max: rateLimitLimits.loginPerEmail(),
                timeWindow: '1 minute',
                keyGenerator: bodyFieldKey('email'),
            },
        }),
    }, async (request) => {
        const body = request.body as any;
        const result = await loginUser(app, body);
        return { success: true, ...result };
    });

    app.post('/auth/refresh', {
        config: typedRouteConfig({
            zodSchema: refreshSchema,
            rateLimit: {
                max: rateLimitLimits.refreshPerSession(),
                timeWindow: '1 minute',
                keyGenerator: bodyFieldKey('session_id'),
            },
        }),
    }, async (request) => {
        const body = request.body as any;
        const result = await refreshSession(app, body);
        return { success: true, ...result };
    });

    app.post('/auth/logout', {
        config: typedRouteConfig({
            zodSchema: logoutSchema,
            rateLimit: {
                max: 10,
                timeWindow: '1 minute',
                keyGenerator: bodyFieldKey('session_id'),
            },
        }),
    }, async (request) => {
        const body = request.body as any;
        const result = await logoutSession(app, body);
        return result;
    });

    app.get('/auth/me', {
        preHandler: [app.authenticate],
    }, async (request) => {
        return {
            success: true,
            user: {
                id: (request.user as any).userId,
                email: (request.user as any).email,
            },
        };
    });

    app.post('/auth/reauthenticate', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({
            zodSchema: reauthenticateSchema,
            rateLimit: { max: 5, timeWindow: '1 minute' },
        }),
    }, async (request) => {
        const body = request.body as any;
        const result = await reauthenticateUser(
            app,
            (request.user as any).userId,
            body.password,
        );
        return { success: true, ...result };
    });
};

export default authRoutes;
