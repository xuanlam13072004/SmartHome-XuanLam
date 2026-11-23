import 'fastify';
import type { RequiredPermission } from '../modules/admin/permissions';
import type { StaffSession } from '../modules/admin/staff';

declare module 'fastify' {
    interface FastifyRequest {
        /** The Admin Console staff member behind an /admin request (modules/admin/guard.ts). */
        staff?: StaffSession;
    }

    interface FastifyContextConfig {
        /**
         * /admin routes: the permission needed; 'signed-in' for any staff member,
         * 'none' for signing in (the server key is still required).
         */
        adminPermission?: RequiredPermission | 'signed-in' | 'none';
        /** Allowed while the staff member still has a temporary password. */
        beforePasswordChange?: boolean;
    }
}
