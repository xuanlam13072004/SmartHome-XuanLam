/**
 * Account and device-management actions recorded for "Lịch sử hoạt động".
 * Device operations (unlock, watering, camera…) are not duplicated here: the
 * activity feed reads them from device_operations.
 */
export type AuditAction =
    | 'account.profile_updated'
    | 'account.password_changed'
    | 'account.session_revoked'
    | 'account.other_sessions_revoked'
    | 'device.claimed'
    | 'device.renamed'
    | 'device.unpaired'
    | 'sharing.invite_sent'
    | 'sharing.invite_cancelled'
    | 'sharing.invite_accepted'
    | 'sharing.invite_declined'
    | 'sharing.member_updated'
    | 'sharing.member_removed'
    | 'sharing.left';

export interface Queryable {
    query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }>;
}

export interface AuditEntry {
    actorAccountId: string;
    action: AuditAction;
    deviceId?: string | null;
    outcome?: 'success' | 'denied' | 'failed';
    reasonCode?: string | null;
    /** Display facts only (names, roles); never secrets. */
    metadata?: Record<string, unknown>;
}

export async function recordAudit(db: Queryable, entry: AuditEntry): Promise<void> {
    await db.query(
        `INSERT INTO device_audit_logs
            (device_id, actor_account_id, action, outcome, reason_code, metadata)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
            entry.deviceId ?? null,
            entry.actorAccountId,
            entry.action,
            entry.outcome ?? 'success',
            entry.reasonCode ?? null,
            JSON.stringify(entry.metadata ?? {}),
        ],
    );
}
