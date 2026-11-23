import path from 'node:path';
import { z } from 'zod';

/** Environment of the Admin Console backend (docs/architecture/admin.md). */
const schema = z.object({
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    HOST: z.string().default('0.0.0.0'),
    /** The API Gateway inside the Docker network (never through Cloudflare Tunnel). */
    GATEWAY_URL: z.string().url().default('http://api-gateway:3000'),
    /**
     * The Gateway's ADMIN_API_KEY: proves calls to /admin come from this server.
     * Empty = administration not set up: the Console starts and says so.
     */
    ADMIN_API_KEY: z.string().default('').refine(value => value === '' || value.length >= 32, {
        message: 'must be the API Gateway ADMIN_API_KEY (32+ characters) or empty',
    }),
    /** The Device Simulator backend; its ADMIN_TOKEN. Empty token = Simulator section unavailable. */
    SIMULATOR_URL: z.string().url().default('http://simulator-backend:4001'),
    SIMULATOR_TOKEN: z.string().default(''),
    /** Long Simulator actions wait for the Gateway's rate-limit windows. */
    SIMULATOR_TIMEOUT_MS: z.coerce.number().int().min(1000).max(3_600_000).default(360_000),
    /** true when the Console is served over HTTPS (the cookie then travels only over HTTPS). */
    COOKIE_SECURE: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
    /** The built web app; missing = API only (development with Vite). */
    STATIC_DIR: z.string().default(path.resolve(__dirname, '../../frontend/dist')),
});

export type ConsoleConfig = z.infer<typeof schema>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): ConsoleConfig {
    const parsed = schema.safeParse(source);
    if (!parsed.success) {
        const issues = parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ');
        throw new Error(`Invalid Admin Console configuration: ${issues}`);
    }
    return parsed.data;
}
