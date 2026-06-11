import 'fastify';
import type { ZodSchema } from 'zod';

declare module 'fastify' {
    interface FastifyInstance {
        validate: (schema: ZodSchema, data: unknown) => Promise<unknown>;
    }

    interface RouteShorthandOptions {
        validationSchema?: ZodSchema;
    }
}

