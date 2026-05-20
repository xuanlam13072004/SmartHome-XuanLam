import { FastifyError, FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

/**
 * errorHandlerPlugin
 * - Chuẩn hóa format lỗi toàn hệ thống
 * - Đảm bảo mọi lỗi trả cùng 1 cấu trúc JSON
 */
const errorHandlerPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
    app.setErrorHandler((error: FastifyError, request, reply) => {
        const statusCode = error.statusCode || 500;

        // Default response format
        const response = {
            success: false,
            error: {
                code: error.code || 'INTERNAL_ERROR',
                message: error.message || 'Internal server error',
            },
            meta: {
                requestId: request.id,
                path: request.url,
                method: request.method,
            },
        };

        // Log error với severity phù hợp
        if (statusCode >= 500) {
            request.log.error({ err: error }, 'Unhandled server error');
        } else {
            request.log.warn({ err: error }, 'Request error');
        }

        reply.status(statusCode).send(response);
    });
};

export default fp(errorHandlerPlugin, {
    name: 'error-handler-plugin',
});
