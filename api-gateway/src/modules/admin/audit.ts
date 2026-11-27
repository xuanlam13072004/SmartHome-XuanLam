import type { Queryable } from '../activity/audit';

/**
 * The administration log (admin_audit_log): every change staff make to a
 * customer's account, plan or order, to staff accounts, and every change made
 * in the Simulator, with who did it and why.
 */
export type AdminAction =
    | 'account.disabled'
    | 'account.enabled'
    | 'account.signed_out'
    | 'plan.gifted'
    | 'payment.confirmed'
    | 'payment.cancelled'
    | 'staff.created'
    | 'staff.updated'
    | 'staff.disabled'
    | 'staff.enabled'
    | 'staff.password_reset'
    | 'staff.signed_out'
    | 'simulator.request'
    | 'weather.mock_set'
    | 'weather.mock_cleared'
    | 'weather.account_mock_set'
    | 'weather.account_mock_cleared';

/** A staff member signed in to the Admin Console, or a tool run inside the Gateway container. */
export type AdminActor = { kind: 'staff'; id: string; email: string } | { kind: 'cli' };

export const CLI: AdminActor = { kind: 'cli' };

export interface AdminAuditEntry {
    actor: AdminActor;
    action: AdminAction;
    targetAccountId?: string | null;
    targetEmail?: string | null;
    reason: string;
    /** Facts for the log (counts, plan, amounts, staff changed); never secrets. */
    details?: Record<string, unknown>;
}

export async function recordAdminAction(db: Queryable, entry: AdminAuditEntry): Promise<void> {
    const staff = entry.actor.kind === 'staff' ? entry.actor : null;
    await db.query(
        `INSERT INTO admin_audit_log
            (actor, staff_id, staff_email, action, target_account_id, target_email, reason, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [
            entry.actor.kind,
            staff?.id ?? null,
            staff?.email ?? null,
            entry.action,
            entry.targetAccountId ?? null,
            entry.targetEmail ?? null,
            entry.reason.trim(),
            JSON.stringify(entry.details ?? {}),
        ],
    );
}

export interface AuditPage {
    page: number;
    pageSize: number;
    action?: string;
    accountId?: string;
    staffId?: string;
}

export async function listAdminActions(db: Queryable, query: AuditPage) {
    const where: string[] = [];
    const params: unknown[] = [];
    const filter = (sql: string, value: unknown) => {
        params.push(value);
        where.push(sql.replace('?', `$${params.length}`));
    };
    if (query.action) filter('log.action = ?', query.action);
    if (query.accountId) filter('log.target_account_id = ?', query.accountId);
    if (query.staffId) filter('log.staff_id = ?', query.staffId);
    params.push(query.pageSize, (query.page - 1) * query.pageSize);
    const result = await db.query(
        `SELECT log.id, log.actor, log.staff_id, COALESCE(staff.email, log.staff_email) AS staff_email,
                staff.full_name AS staff_name, log.action, log.target_account_id, log.target_email,
                log.reason, log.details, log.created_at, count(*) OVER () AS total
         FROM admin_audit_log AS log
         LEFT JOIN staff_accounts AS staff ON staff.id = log.staff_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY log.created_at DESC, log.id DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
    );
    return {
        items: result.rows.map(row => ({
            id: Number(row.id),
            /** 'staff' (with who), 'cli', or 'admin' for entries written before staff accounts existed. */
            actor: {
                kind: row.actor as string,
                ...(row.actor === 'staff'
                    ? { id: row.staff_id as string | null, email: row.staff_email as string | null, name: row.staff_name as string | null }
                    : {}),
            },
            action: row.action as string,
            account: row.target_account_id || row.target_email
                ? { id: row.target_account_id as string | null, email: row.target_email as string | null }
                : null,
            reason: row.reason as string,
            details: row.details as Record<string, unknown>,
            created_at: new Date(row.created_at).toISOString(),
        })),
        total: Number(result.rows[0]?.total ?? 0),
        page: query.page,
        page_size: query.pageSize,
    };
}
