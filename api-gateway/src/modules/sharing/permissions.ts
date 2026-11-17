import { httpError } from '../../utils/httpError';
import type { Queryable } from '../activity/audit';

export type MemberRole = 'viewer' | 'controller';

/** A viewer sees the device (and its camera); a controller may also operate it. */
const VIEWER_SCOPES = new Set(['device.view', 'camera.view']);

interface CatalogReader {
    getProduct: (productId: string) => { permissions?: string[] } | null;
}

/**
 * Scopes of this product an owner may hand to others. Owner-only and
 * non-delegable scopes (recording deletion, PIN codes, safety settings,
 * sharing, unpairing) never leave the owner; the database enforces this too.
 */
export async function shareableScopes(db: Queryable, catalog: CatalogReader, productId: string): Promise<string[]> {
    const productScopes = catalog.getProduct(productId)?.permissions ?? [];
    if (productScopes.length === 0) return [];
    const result = await db.query(
        `SELECT scope FROM permission_scopes
         WHERE delegable = true AND owner_only = false AND scope = ANY($1::text[])
         ORDER BY scope`,
        [productScopes],
    );
    return result.rows.map(row => row.scope as string);
}

export function rolePermissions(role: MemberRole, shareable: string[]): string[] {
    return role === 'controller' ? [...shareable] : shareable.filter(scope => VIEWER_SCOPES.has(scope));
}

/**
 * Permissions for a member: the role preset, or an explicit subset of the
 * shareable scopes. `device.view` is always included: every member sees the device.
 */
export function resolvePermissions(role: MemberRole, shareable: string[], requested?: string[]): string[] {
    if (!requested) return rolePermissions(role, shareable);
    const allowed = new Set(shareable);
    const invalid = requested.filter(scope => !allowed.has(scope));
    if (invalid.length > 0) {
        throw httpError(400, 'PERMISSION_NOT_SHAREABLE', `Cannot share: ${invalid.join(', ')}`);
    }
    return [...new Set([...requested, ...(allowed.has('device.view') ? ['device.view'] : [])])].sort();
}
