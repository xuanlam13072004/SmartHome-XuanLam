import { FastifyInstance, FastifyPluginAsync } from 'fastify';
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
        validationSchema: registerSchema,
    }, async (request) => {
        const body = request.body as any;
        const user = await registerUser(app, body);
        return { success: true, user };
    });

    app.post('/auth/login', {
        validationSchema: loginSchema,
        config: {
            rateLimit: {
                max: 5,
                timeWindow: '1 minute',
            },
        },
    }, async (request) => {
        const body = request.body as any;
        const result = await loginUser(app, body);
        return { success: true, ...result };
    });

    app.post('/auth/refresh', {
        validationSchema: refreshSchema,
    }, async (request) => {
        const body = request.body as any;
        const result = await refreshSession(app, body);
        return { success: true, ...result };
    });

    app.post('/auth/logout', {
        validationSchema: logoutSchema,
    }, async (request) => {
        const body = request.body as any;
        const result = await logoutSession(app, body);
        return { success: true, ...result };
    });

    app.get('/auth/me', {
        preHandler: [app.authenticate],
    }, async (request) => {
        return {
            success: true,
            user: {
                id: request.user.userId,
                email: request.user.email,
            },
        };
    });
};

export default authRoutes;
