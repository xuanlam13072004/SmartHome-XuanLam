import { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply, FastifyContextConfig } from 'fastify';
import fp from 'fastify-plugin';
import { ZodError, ZodSchema } from 'zod';

export function typedRouteConfig(config: FastifyContextConfig): FastifyContextConfig {
    return config;
}

/**
 * validationPlugin
 * - Chuẩn hóa validate request bằng Zod
 * - Cung cấp helper app.validate() để dùng trong route
 */
const validationPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
    app.decorate('validate', async (schema: ZodSchema, data: unknown) => {
        try {
            return schema.parse(data);
        } catch (err) {
            if (err instanceof ZodError) {
                const issues = err.issues.map(i => ({ path: i.path, message: i.message }));
                const error = new Error('Validation error') as any;
                error.statusCode = 400;
                error.code = 'VALIDATION_ERROR';
                error.details = issues;
                throw error;
            }
            throw err;
        }
    });

    // Optional hook: tự động validate request body/query/params nếu route cung cấp schema qua config.zodSchema
    app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
        const schema = request.routeOptions.config?.zodSchema;
        if (!schema) return;

        const { body, query, params } = request;
        const payload = { body, query, params };

        const parsed = await (app as any).validate(schema, payload) as any;
        // Zod transforms/defaults are part of the request contract. Keep the
        // normalized values instead of validating a copy and discarding it.
        if (parsed.body !== undefined) request.body = parsed.body;
        if (parsed.query !== undefined) request.query = parsed.query;
        if (parsed.params !== undefined) request.params = parsed.params;
    });
};

export default fp(validationPlugin, {
    name: 'validation-plugin',
});
