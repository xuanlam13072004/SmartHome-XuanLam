import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { typedRouteConfig } from '../../plugins/validation';
import { loginSchema, logoutSchema, refreshSchema, registerSchema } from './schemas';
import { loginUser, logoutSession, refreshSession, registerUser } from './service';

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
                max: 5,
                timeWindow: '1 minute',
            },
        }),
    }, async (request) => {
        const body = request.body as any;
        const user = await registerUser(app, body);
        return { success: true, user };
    });

    app.post('/auth/login', {
        config: typedRouteConfig({
            zodSchema: loginSchema,
            rateLimit: {
                max: 5,
                timeWindow: '1 minute',
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
        }),
    }, async (request) => {
        const body = request.body as any;
        const result = await refreshSession(app, body);
        return { success: true, ...result };
    });

    app.post('/auth/logout', {
        config: typedRouteConfig({
            zodSchema: logoutSchema,
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
};

export default authRoutes;
