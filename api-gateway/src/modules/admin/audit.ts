import type { Queryable } from '../activity/audit';

/**
 * The administration log (admin_audit_log): every change staff make to a
 * customer's account, plan or order, with the reason they gave.
 */
export type AdminAction =
    | 'account.disabled'
    | 'account.enabled'
    | 'account.signed_out'
    | 'plan.gifted'
    | 'payment.confirmed'
    | 'payment.cancelled';

/** 'admin': the Simulator's "Quản trị" page; 'cli': a tool inside the Gateway container. */
export type AdminActor = 'admin' | 'cli';

export interface AdminAuditEntry {
    actor: AdminActor;
    action: AdminAction;
    targetAccountId?: string | null;
    targetEmail?: string | null;
    reason: string;
    /** Facts for the log (counts, plan, amounts); never secrets. */
    details?: Record<string, unknown>;
}

export async function recordAdminAction(db: Queryable, entry: AdminAuditEntry): Promise<void> {
    await db.query(
        `INSERT INTO admin_audit_log (actor, action, target_account_id, target_email, reason, details)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
            entry.actor,
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
}

export async function listAdminActions(db: Queryable, query: AuditPage) {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.action) {
        params.push(query.action);
        where.push(`log.action = $${params.length}`);
    }
    if (query.accountId) {
        params.push(query.accountId);
        where.push(`log.target_account_id = $${params.length}`);
    }
    params.push(query.pageSize, (query.page - 1) * query.pageSize);
    const result = await db.query(
        `SELECT log.id, log.actor, log.action, log.target_account_id, log.target_email, log.reason, log.details,
                log.created_at, count(*) OVER () AS total
         FROM admin_audit_log AS log
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY log.created_at DESC, log.id DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
    );
    return {
        items: result.rows.map(row => ({
            id: Number(row.id),
            actor: row.actor as string,
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
