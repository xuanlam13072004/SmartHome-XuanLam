import { FastifyError, FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

/**
 * errorHandlerPlugin
 * - Chuẩn hóa format lỗi toàn hệ thống
 * - Đảm bảo mọi lỗi trả cùng 1 cấu trúc JSON
 */
const errorHandlerPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
    app.setErrorHandler((error: FastifyError, request, reply) => {
        let statusCode = error.statusCode || 500;
        let errorCode = error.code || 'INTERNAL_ERROR';
        let errorMessage = error.message || 'Internal server error';

        // @fastify/rate-limit throws a plain object without a code: give clients a stable one.
        if (statusCode === 429 && (!error.code || error.code === 'FST_ERR_RATE_LIMIT')) {
            errorCode = 'RATE_LIMITED';
        }

        // Map riêng lỗi Postgres unique constraint (23505) -> 409
        if ((error as any).code === '23505') {
            statusCode = 409;
            errorCode = 'CONFLICT';
            errorMessage = 'Resource already exists or constraint violation.';
        } else if (statusCode >= 500) {
            // Ẩn chi tiết lỗi với các lỗi 5xx
            errorMessage = 'Internal server error';
        }

        // Default response format
        // Field-level details of a client error (validation issues, which recording failed).
        const details = statusCode < 500 ? (error as { details?: unknown }).details : undefined;
        const response = {
            success: false,
            error: {
                code: errorCode,
                message: errorMessage,
                ...(details !== undefined ? { details } : {}),
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
