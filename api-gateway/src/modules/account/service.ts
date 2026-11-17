import type { FastifyInstance } from 'fastify';
import { httpError } from '../../utils/httpError';
import { recordAudit } from '../activity/audit';

export interface AccountProfile {
    id: string;
    email: string;
    full_name: string;
    created_at: string;
}

export interface AccountOverview {
    user: AccountProfile;
    stats: {
        /** Devices this account owns. */
        owned_devices: number;
        /** Devices other owners share with this account. */
        shared_devices: number;
        /** Invitations waiting for this account to accept or decline. */
        pending_invites: number;
    };
}

/**
 * Profile header and counters of "Cá nhân" in one round trip. Every count is
 * an index range scan bounded by the account's own rows.
 */
export async function getAccountOverview(app: FastifyInstance, accountId: string): Promise<AccountOverview> {
    const result = await app.pg.query(
        `SELECT account.id, account.email, account.full_name, account.created_at,
                memberships.owned_devices, memberships.shared_devices,
                (SELECT count(*)::int
                   FROM device_invites AS invite
                  WHERE lower(invite.invited_email) = account.email
                    AND invite.status = 'pending'
                    AND invite.expires_at > NOW()) AS pending_invites
         FROM accounts AS account
         CROSS JOIN LATERAL (
             SELECT count(*) FILTER (WHERE membership.role = 'owner')::int AS owned_devices,
                    count(*) FILTER (WHERE membership.role <> 'owner')::int AS shared_devices
             FROM device_memberships AS membership
             JOIN device_metadata AS device
               ON device.id = membership.device_id AND device.is_active = true
             WHERE membership.account_id = account.id
               AND membership.status = 'active'
               AND (membership.expires_at IS NULL OR membership.expires_at > NOW())
         ) AS memberships
         WHERE account.id = $1 AND account.status = 'active'`,
        [accountId],
    );
    const row = result.rows[0];
    if (!row) throw httpError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
    return {
        user: toProfile(row),
        stats: {
            owned_devices: row.owned_devices,
            shared_devices: row.shared_devices,
            pending_invites: row.pending_invites,
        },
    };
}

export async function updateProfile(
    app: FastifyInstance,
    accountId: string,
    input: { full_name: string },
): Promise<AccountProfile> {
    const client = await app.pg.connect();
    try {
        await client.query('BEGIN');
        const result = await client.query(
            `UPDATE accounts SET full_name = $2
             WHERE id = $1 AND status = 'active'
             RETURNING id, email, full_name, created_at`,
            [accountId, input.full_name],
        );
        if (!result.rows[0]) throw httpError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
        await recordAudit(client, {
            actorAccountId: accountId,
            action: 'account.profile_updated',
            metadata: { full_name: input.full_name },
        });
        await client.query('COMMIT');
        return toProfile(result.rows[0]);
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

function toProfile(row: any): AccountProfile {
    return {
        id: row.id,
        email: row.email,
        full_name: row.full_name,
        created_at: new Date(row.created_at).toISOString(),
    };
}
