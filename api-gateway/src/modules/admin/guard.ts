import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../../config/env';
import { ipKey } from '../../plugins/rateLimit';
import { httpError } from '../../utils/httpError';
import { staffCan } from './permissions';
import { loadStaffSession } from './staff';

/**
 * Who may call /admin/* (docs/architecture/admin.md). Two keys, both needed:
 * 1. the server key: only the Admin Console's backend holds ADMIN_API_KEY,
 *    inside the Docker network:
 *    - no key configured → the API does not exist (404);
 *    - a request that came through Cloudflare Tunnel → refused whatever it
 *      carries: the administration API is never reachable from the Internet;
 *    - wrong key → 401, repeated wrong keys from one address slowed down;
 * 2. the staff session the Console holds for the signed-in person
 *    (X-Staff-Session), whose permissions must include the route's.
 * A customer's token is never accepted here.
 */

/** Cloudflare adds these to every request it forwards through the tunnel. */
const TUNNEL_HEADERS = ['cf-ray', 'cf-connecting-ip'] as const;

export function cameThroughTunnel(headers: Record<string, unknown>): boolean {
    return TUNNEL_HEADERS.some(name => headers[name] !== undefined);
}

/** Constant-time comparison of the presented key with the configured one. */
export function adminKeyMatches(presented: unknown, configured: string): boolean {
    if (typeof presented !== 'string' || configured === '') return false;
    const left = crypto.createHash('sha256').update(presented).digest();
    const right = crypto.createHash('sha256').update(configured).digest();
    return crypto.timingSafeEqual(left, right);
}

export const ADMIN_KEY_HEADER = 'x-admin-key';
export const STAFF_SESSION_HEADER = 'x-staff-session';
/** Set by the Console (trusted only with the server key): the browser's address and name. */
export const STAFF_CLIENT_IP_HEADER = 'x-staff-client-ip';
export const STAFF_CLIENT_HEADER = 'x-staff-client';
const WRONG_KEYS_PER_MINUTE = 20;

export function adminGuard(app: FastifyInstance) {
    const countWrongKey = app.limitBy('admin-key', ipKey, WRONG_KEYS_PER_MINUTE);
    return async (request: FastifyRequest, reply: FastifyReply) => {
        if (!env.ADMIN_API_KEY) throw httpError(404, 'NOT_FOUND', 'Not found');
        if (cameThroughTunnel(request.headers)) {
            throw httpError(403, 'ADMIN_INTERNAL_ONLY', 'The administration API is only reachable inside the server network');
        }
        if (!adminKeyMatches(request.headers[ADMIN_KEY_HEADER], env.ADMIN_API_KEY)) {
            await countWrongKey(request, reply);
            throw httpError(401, 'ADMIN_KEY_INVALID', 'Invalid administration key');
        }
        const config = request.routeOptions.config;
        const required = config?.adminPermission;
        if (!required) throw httpError(500, 'ADMIN_ROUTE_UNGUARDED', 'Administration route without a permission');
        if (required === 'none') return;
        const staff = await loadStaffSession(app, request.headers[STAFF_SESSION_HEADER]);
        if (!staff) throw httpError(401, 'STAFF_SESSION_INVALID', 'Phiên đăng nhập đã hết. Vui lòng đăng nhập lại.');
        request.staff = staff;
        if (staff.must_change_password && !config.beforePasswordChange) {
            throw httpError(403, 'STAFF_PASSWORD_CHANGE_REQUIRED', 'Hãy đổi mật khẩu tạm trước khi tiếp tục.');
        }
        if (required !== 'signed-in' && !staffCan(staff, required)) {
            throw httpError(403, 'STAFF_FORBIDDEN', 'Bạn không có quyền làm việc này.');
        }
    };
}

/** The staff member of a guarded route (set by adminGuard). */
export function staffOf(request: FastifyRequest) {
    if (!request.staff) throw httpError(401, 'STAFF_SESSION_INVALID', 'Phiên đăng nhập đã hết. Vui lòng đăng nhập lại.');
    return request.staff;
}
