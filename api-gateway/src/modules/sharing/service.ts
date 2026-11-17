import crypto from 'crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { REDIS_CHANNELS } from '../../../../shared/constants';
import { env } from '../../config/env';
import { httpError } from '../../utils/httpError';
import { recordAudit } from '../activity/audit';
import { AccessChange, publishAccessChanges, queueAccessProjection } from './access';
import { MemberRole, resolvePermissions, rolePermissions, shareableScopes } from './permissions';

interface OwnedDevice {
    id: string;
    mac: string;
    name: string;
    product_id: string;
    owner_email: string;
    owner_name: string;
}

async function inTransaction<T>(app: FastifyInstance, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await app.pg.connect();
    try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

/** Personal realtime event for one account (no-op when nobody is connected). */
async function notifyAccount(app: FastifyInstance, accountId: string | null, event: string, data: Record<string, unknown>) {
    if (!accountId) return;
    try {
        await app.redis.publish(REDIS_CHANNELS.ACCOUNT_EVENT, JSON.stringify({ account_id: accountId, event, data }));
    } catch (error) {
        app.log.warn({ error, accountId, event }, 'Failed to publish an account event');
    }
}

/**
 * The caller's own active device, row-locked when `lock` so membership changes
 * on one device are serialised (the member limit stays exact). A member of the
 * device gets 403, anyone else 404 (existence is not revealed).
 */
async function loadOwnedDevice(db: PoolClient, mac: string, ownerId: string, lock: boolean): Promise<OwnedDevice> {
    const result = await db.query(
        `SELECT device.id, device.mac, device.name, device.product_id,
                owner.email AS owner_email, owner.full_name AS owner_name
         FROM device_metadata AS device
         JOIN accounts AS owner ON owner.id = device.owner_id
         WHERE device.mac = $1 AND device.owner_id = $2 AND device.is_active = true
         ${lock ? 'FOR UPDATE OF device' : ''}`,
        [mac, ownerId],
    );
    if (result.rows[0]) return result.rows[0];
    const member = await db.query(
        `SELECT 1 FROM device_metadata AS device
         JOIN device_memberships AS membership
           ON membership.device_id = device.id AND membership.account_id = $2 AND membership.status = 'active'
         WHERE device.mac = $1 AND device.is_active = true`,
        [mac, ownerId],
    );
    if (member.rows[0]) throw httpError(403, 'NOT_DEVICE_OWNER', 'Only the device owner can manage sharing');
    throw httpError(404, 'DEVICE_NOT_FOUND', 'Device not found');
}

/** Members plus pending invitations, the number the per-device limit applies to. */
async function seatsUsed(db: PoolClient, deviceId: string): Promise<number> {
    const result = await db.query(
        `SELECT (SELECT count(*) FROM device_memberships
                  WHERE device_id = $1 AND role <> 'owner' AND status = 'active')
              + (SELECT count(*) FROM device_invites
                  WHERE device_id = $1 AND status = 'pending' AND expires_at > NOW()) AS used`,
        [deviceId],
    );
    return Number(result.rows[0].used);
}

async function writeMemberPermissions(
    db: PoolClient,
    deviceId: string,
    accountId: string,
    grantedBy: string,
    permissions: string[],
) {
    await db.query(
        'DELETE FROM device_membership_permissions WHERE device_id = $1 AND account_id = $2',
        [deviceId, accountId],
    );
    if (permissions.length === 0) return;
    await db.query(
        `INSERT INTO device_membership_permissions (device_id, account_id, permission_scope, granted_by)
         SELECT $1, $2, scope, $3 FROM unnest($4::text[]) AS scope`,
        [deviceId, accountId, grantedBy, permissions],
    );
}

// ── Owner: members of one device ────────────────────────────────────────────

export async function listDeviceMembers(app: FastifyInstance, ownerId: string, mac: string) {
    const client = await app.pg.connect();
    try {
        const device = await loadOwnedDevice(client, mac, ownerId, false);
        const [members, invites, shareable] = await Promise.all([
            client.query(
                `SELECT account.id AS account_id, account.full_name, account.email,
                        membership.role, membership.created_at AS joined_at,
                        COALESCE(ARRAY_AGG(permission.permission_scope ORDER BY permission.permission_scope)
                            FILTER (WHERE permission.permission_scope IS NOT NULL), ARRAY[]::text[]) AS permissions
                 FROM device_memberships AS membership
                 JOIN accounts AS account ON account.id = membership.account_id
                 LEFT JOIN device_membership_permissions AS permission
                   ON permission.device_id = membership.device_id AND permission.account_id = membership.account_id
                 WHERE membership.device_id = $1 AND membership.role <> 'owner' AND membership.status = 'active'
                 GROUP BY account.id, membership.role, membership.created_at
                 ORDER BY membership.created_at`,
                [device.id],
            ),
            client.query(
                `SELECT invite.id, invite.invited_email AS email, invite.role,
                        invite.created_at, invite.expires_at,
                        COALESCE(ARRAY_AGG(permission.permission_scope ORDER BY permission.permission_scope)
                            FILTER (WHERE permission.permission_scope IS NOT NULL), ARRAY[]::text[]) AS permissions
                 FROM device_invites AS invite
                 LEFT JOIN device_invite_permissions AS permission ON permission.invite_id = invite.id
                 WHERE invite.device_id = $1 AND invite.status = 'pending' AND invite.expires_at > NOW()
                 GROUP BY invite.id
                 ORDER BY invite.created_at DESC`,
                [device.id],
            ),
            shareableScopes(client, app.catalog, device.product_id),
        ]);
        return {
            device: { mac: device.mac, name: device.name, product_id: device.product_id },
            members: members.rows.map(row => ({
                account_id: row.account_id,
                full_name: row.full_name,
                email: row.email,
                role: row.role,
                permissions: row.permissions,
                joined_at: new Date(row.joined_at).toISOString(),
            })),
            invites: invites.rows.map(row => ({
                id: row.id,
                email: row.email,
                role: row.role,
                permissions: row.permissions,
                created_at: new Date(row.created_at).toISOString(),
                expires_at: new Date(row.expires_at).toISOString(),
            })),
            role_permissions: {
                viewer: rolePermissions('viewer', shareable),
                controller: rolePermissions('controller', shareable),
            },
            limits: { max_members: env.MAX_DEVICE_MEMBERS, used: members.rows.length + invites.rows.length },
        };
    } finally {
        client.release();
    }
}

/**
 * Invites an e-mail address. The invitee accepts in the app after signing in
 * with that address (an account may not exist yet). The answer never reveals
 * whether the address has an account.
 */
export async function inviteMember(
    app: FastifyInstance,
    ownerId: string,
    mac: string,
    input: { email: string; role: MemberRole; permissions?: string[] },
) {
    const email = input.email.trim().toLowerCase();
    const { invite, inviteeId, device } = await inTransaction(app, async (client) => {
        const device = await loadOwnedDevice(client, mac, ownerId, true);
        if (device.owner_email === email) {
            throw httpError(400, 'CANNOT_INVITE_SELF', 'You already own this device');
        }
        const member = await client.query(
            `SELECT 1 FROM device_memberships AS membership
             JOIN accounts AS account ON account.id = membership.account_id
             WHERE membership.device_id = $1 AND account.email = $2 AND membership.status = 'active'`,
            [device.id, email],
        );
        if (member.rows[0]) throw httpError(409, 'ALREADY_MEMBER', 'This person already has access');

        // A lapsed invitation must not block a new one (unique pending index).
        await client.query(
            `UPDATE device_invites SET status = 'expired'
             WHERE device_id = $1 AND lower(invited_email) = $2
               AND status = 'pending' AND expires_at <= NOW()`,
            [device.id, email],
        );
        const pending = await client.query(
            `SELECT 1 FROM device_invites
             WHERE device_id = $1 AND lower(invited_email) = $2 AND status = 'pending'`,
            [device.id, email],
        );
        if (pending.rows[0]) throw httpError(409, 'INVITE_ALREADY_PENDING', 'An invitation is already waiting');
        if (await seatsUsed(client, device.id) >= env.MAX_DEVICE_MEMBERS) {
            throw httpError(409, 'MEMBER_LIMIT_REACHED', `A device can be shared with at most ${env.MAX_DEVICE_MEMBERS} people`);
        }

        const shareable = await shareableScopes(client, app.catalog, device.product_id);
        const permissions = resolvePermissions(input.role, shareable, input.permissions);
        const token = crypto.randomBytes(32).toString('hex');
        const inserted = await client.query(
            `INSERT INTO device_invites (device_id, invited_email, role, token_hash, invited_by, expires_at)
             VALUES ($1, $2, $3, $4, $5, NOW() + make_interval(hours => $6))
             RETURNING id, invited_email AS email, role, created_at, expires_at`,
            [device.id, email, input.role, crypto.createHash('sha256').update(token).digest('hex'), ownerId, env.INVITE_TTL_HOURS],
        );
        const invite = inserted.rows[0];
        if (permissions.length > 0) {
            await client.query(
                `INSERT INTO device_invite_permissions (invite_id, permission_scope)
                 SELECT $1, scope FROM unnest($2::text[]) AS scope`,
                [invite.id, permissions],
            );
        }
        await recordAudit(client, {
            actorAccountId: ownerId,
            deviceId: device.id,
            action: 'sharing.invite_sent',
            metadata: { device_name: device.name, email, role: input.role },
        });
        const invitee = await client.query(
            `SELECT id FROM accounts WHERE email = $1 AND status = 'active'`,
            [email],
        );
        return { invite: { ...invite, permissions }, inviteeId: invitee.rows[0]?.id ?? null, device };
    });

    await notifyAccount(app, inviteeId, 'sharing_invite_received', {
        invite_id: invite.id,
        device_name: device.name,
        owner_name: device.owner_name,
    });
    return {
        id: invite.id,
        email: invite.email,
        role: invite.role,
        permissions: invite.permissions,
        created_at: new Date(invite.created_at).toISOString(),
        expires_at: new Date(invite.expires_at).toISOString(),
    };
}

export async function cancelInvite(app: FastifyInstance, ownerId: string, mac: string, inviteId: string) {
    const { inviteeId } = await inTransaction(app, async (client) => {
        const device = await loadOwnedDevice(client, mac, ownerId, true);
        const result = await client.query(
            `UPDATE device_invites SET status = 'revoked'
             WHERE id = $1 AND device_id = $2 AND status = 'pending'
             RETURNING invited_email`,
            [inviteId, device.id],
        );
        if (!result.rows[0]) throw httpError(404, 'INVITE_NOT_FOUND', 'Invitation not found');
        await recordAudit(client, {
            actorAccountId: ownerId,
            deviceId: device.id,
            action: 'sharing.invite_cancelled',
            metadata: { device_name: device.name, email: result.rows[0].invited_email },
        });
        const invitee = await client.query(
            `SELECT id FROM accounts WHERE email = $1 AND status = 'active'`,
            [result.rows[0].invited_email],
        );
        return { inviteeId: invitee.rows[0]?.id ?? null };
    });
    await notifyAccount(app, inviteeId, 'sharing_invite_cancelled', { invite_id: inviteId });
}

export async function updateMember(
    app: FastifyInstance,
    ownerId: string,
    mac: string,
    memberId: string,
    input: { role: MemberRole; permissions?: string[] },
) {
    const change = await inTransaction(app, async (client) => {
        const device = await loadOwnedDevice(client, mac, ownerId, true);
        const updated = await client.query(
            `UPDATE device_memberships AS membership SET role = $3
             FROM accounts AS account
             WHERE membership.device_id = $1 AND membership.account_id = $2
               AND membership.role <> 'owner' AND membership.status = 'active'
               AND account.id = membership.account_id
             RETURNING account.email, account.full_name`,
            [device.id, memberId, input.role],
        );
        if (!updated.rows[0]) throw httpError(404, 'MEMBER_NOT_FOUND', 'Member not found');
        const shareable = await shareableScopes(client, app.catalog, device.product_id);
        await writeMemberPermissions(client, device.id, memberId, ownerId,
            resolvePermissions(input.role, shareable, input.permissions));
        await recordAudit(client, {
            actorAccountId: ownerId,
            deviceId: device.id,
            action: 'sharing.member_updated',
            metadata: { device_name: device.name, email: updated.rows[0].email, role: input.role },
        });
        return queueAccessProjection(client, app.catalog, device.id);
    });
    await publishAccessChanges(app, [change]);
}

export async function removeMember(app: FastifyInstance, ownerId: string, mac: string, memberId: string) {
    const change = await inTransaction(app, async (client) => {
        const device = await loadOwnedDevice(client, mac, ownerId, true);
        const removed = await client.query(
            `DELETE FROM device_memberships AS membership
             USING accounts AS account
             WHERE membership.device_id = $1 AND membership.account_id = $2
               AND membership.role <> 'owner' AND account.id = membership.account_id
             RETURNING account.email, account.full_name`,
            [device.id, memberId],
        );
        if (!removed.rows[0]) throw httpError(404, 'MEMBER_NOT_FOUND', 'Member not found');
        await recordAudit(client, {
            actorAccountId: ownerId,
            deviceId: device.id,
            action: 'sharing.member_removed',
            metadata: { device_name: device.name, email: removed.rows[0].email, full_name: removed.rows[0].full_name },
        });
        return queueAccessProjection(client, app.catalog, device.id, [memberId]);
    });
    await publishAccessChanges(app, [change]);
}

// ── Member: invitations and devices shared with me ─────────────────────────

/** Everything "Chia sẻ thiết bị" shows, in one request. */
export async function getSharingOverview(app: FastifyInstance, accountId: string) {
    const account = await app.pg.query(`SELECT email FROM accounts WHERE id = $1`, [accountId]);
    const email = account.rows[0]?.email;
    if (!email) throw httpError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
    const [invites, shared, owned] = await Promise.all([
        app.pg.query(
            `SELECT invite.id, invite.role, invite.created_at, invite.expires_at,
                    device.mac, device.name AS device_name, device.product_id,
                    owner.full_name AS owner_name, owner.email AS owner_email,
                    COALESCE(ARRAY_AGG(permission.permission_scope ORDER BY permission.permission_scope)
                        FILTER (WHERE permission.permission_scope IS NOT NULL), ARRAY[]::text[]) AS permissions
             FROM device_invites AS invite
             JOIN device_metadata AS device ON device.id = invite.device_id AND device.is_active = true
             JOIN accounts AS owner ON owner.id = invite.invited_by
             LEFT JOIN device_invite_permissions AS permission ON permission.invite_id = invite.id
             WHERE lower(invite.invited_email) = $1 AND invite.status = 'pending' AND invite.expires_at > NOW()
             GROUP BY invite.id, device.mac, device.name, device.product_id, owner.full_name, owner.email
             ORDER BY invite.created_at DESC
             LIMIT 50`,
            [email],
        ),
        app.pg.query(
            `SELECT device.mac, device.name, device.product_id, membership.role,
                    membership.created_at AS joined_at,
                    owner.full_name AS owner_name, owner.email AS owner_email,
                    COALESCE(ARRAY_AGG(permission.permission_scope ORDER BY permission.permission_scope)
                        FILTER (WHERE permission.permission_scope IS NOT NULL), ARRAY[]::text[]) AS permissions
             FROM device_memberships AS membership
             JOIN device_metadata AS device ON device.id = membership.device_id AND device.is_active = true
             JOIN accounts AS owner ON owner.id = device.owner_id
             LEFT JOIN device_membership_permissions AS permission
               ON permission.device_id = membership.device_id AND permission.account_id = membership.account_id
             WHERE membership.account_id = $1 AND membership.role <> 'owner' AND membership.status = 'active'
             GROUP BY device.id, membership.role, membership.created_at, owner.full_name, owner.email
             ORDER BY lower(device.name)
             LIMIT 200`,
            [accountId],
        ),
        app.pg.query(
            `SELECT device.mac, device.name, device.product_id,
                    (SELECT count(*)::int FROM device_memberships AS membership
                      WHERE membership.device_id = device.id AND membership.role <> 'owner'
                        AND membership.status = 'active') AS member_count,
                    (SELECT count(*)::int FROM device_invites AS invite
                      WHERE invite.device_id = device.id AND invite.status = 'pending'
                        AND invite.expires_at > NOW()) AS pending_invites
             FROM device_metadata AS device
             WHERE device.owner_id = $1 AND device.is_active = true
             ORDER BY lower(device.name)
             LIMIT 200`,
            [accountId],
        ),
    ]);
    return {
        invites: invites.rows.map(row => ({
            id: row.id,
            role: row.role,
            permissions: row.permissions,
            created_at: new Date(row.created_at).toISOString(),
            expires_at: new Date(row.expires_at).toISOString(),
            device: { mac: row.mac, name: row.device_name, product_id: row.product_id },
            owner: { full_name: row.owner_name, email: row.owner_email },
        })),
        shared_with_me: shared.rows.map(row => ({
            device: { mac: row.mac, name: row.name, product_id: row.product_id },
            owner: { full_name: row.owner_name, email: row.owner_email },
            role: row.role,
            permissions: row.permissions,
            joined_at: new Date(row.joined_at).toISOString(),
        })),
        my_devices: owned.rows.map(row => ({
            device: { mac: row.mac, name: row.name, product_id: row.product_id },
            member_count: row.member_count,
            pending_invites: row.pending_invites,
        })),
    };
}

export async function acceptInvite(app: FastifyInstance, accountId: string, inviteId: string) {
    const { change, result, ownerId, memberName } = await inTransaction(app, async (client) => {
        const account = await client.query(
            `SELECT email, full_name FROM accounts WHERE id = $1 AND status = 'active'`,
            [accountId],
        );
        const me = account.rows[0];
        if (!me) throw httpError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
        const found = await client.query(
            `SELECT invite.id, invite.role, invite.status, invite.expires_at <= NOW() AS expired,
                    invite.invited_by, device.id AS device_id, device.mac, device.name, device.owner_id
             FROM device_invites AS invite
             JOIN device_metadata AS device ON device.id = invite.device_id AND device.is_active = true
             WHERE invite.id = $1 AND lower(invite.invited_email) = $2
             FOR UPDATE OF invite, device`,
            [inviteId, me.email],
        );
        const invite = found.rows[0];
        if (!invite) throw httpError(404, 'INVITE_NOT_FOUND', 'Invitation not found');
        if (invite.status !== 'pending') throw httpError(409, 'INVITE_NOT_PENDING', 'Invitation is no longer open');
        if (invite.owner_id === accountId) throw httpError(400, 'CANNOT_INVITE_SELF', 'You already own this device');
        if (invite.expired) {
            await client.query(`UPDATE device_invites SET status = 'expired' WHERE id = $1`, [invite.id]);
            throw httpError(409, 'INVITE_EXPIRED', 'Invitation has expired');
        }

        await client.query(
            `INSERT INTO device_memberships (device_id, account_id, role, granted_by)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (device_id, account_id)
             DO UPDATE SET role = EXCLUDED.role, status = 'active', granted_by = EXCLUDED.granted_by,
                 -- A re-shared device starts outside the member's rooms again.
                 room_id = NULL
             WHERE device_memberships.role <> 'owner'`,
            [invite.device_id, accountId, invite.role, invite.invited_by],
        );
        const permissions = await client.query(
            `SELECT permission_scope FROM device_invite_permissions WHERE invite_id = $1`,
            [invite.id],
        );
        await writeMemberPermissions(client, invite.device_id, accountId, invite.invited_by,
            permissions.rows.map(row => row.permission_scope));
        await client.query(
            `UPDATE device_invites
             SET status = 'accepted', accepted_by = $2, accepted_at = NOW()
             WHERE id = $1`,
            [invite.id, accountId],
        );
        await recordAudit(client, {
            actorAccountId: accountId,
            deviceId: invite.device_id,
            action: 'sharing.invite_accepted',
            metadata: { device_name: invite.name, role: invite.role },
        });
        return {
            change: await queueAccessProjection(client, app.catalog, invite.device_id),
            result: { device: { mac: invite.mac, name: invite.name }, role: invite.role },
            ownerId: invite.owner_id as string,
            memberName: me.full_name as string,
        };
    });
    await publishAccessChanges(app, [change]);
    await notifyAccount(app, ownerId, 'sharing_member_joined', {
        device_name: result.device.name,
        member_name: memberName,
    });
    return result;
}

export async function declineInvite(app: FastifyInstance, accountId: string, inviteId: string) {
    await inTransaction(app, async (client) => {
        const result = await client.query(
            `UPDATE device_invites AS invite SET status = 'revoked'
             FROM accounts AS account, device_metadata AS device
             WHERE invite.id = $1 AND account.id = $2
               AND lower(invite.invited_email) = account.email
               AND invite.status = 'pending'
               AND device.id = invite.device_id
             RETURNING invite.device_id, device.name`,
            [inviteId, accountId],
        );
        if (!result.rows[0]) throw httpError(404, 'INVITE_NOT_FOUND', 'Invitation not found');
        await recordAudit(client, {
            actorAccountId: accountId,
            deviceId: result.rows[0].device_id,
            action: 'sharing.invite_declined',
            metadata: { device_name: result.rows[0].name },
        });
    });
}

/** A member removes a shared device from their own account. */
export async function leaveDevice(app: FastifyInstance, accountId: string, mac: string) {
    const change = await inTransaction(app, async (client) => {
        const device = await client.query(
            `SELECT id, name, owner_id FROM device_metadata
             WHERE mac = $1 AND is_active = true FOR UPDATE`,
            [mac],
        );
        const row = device.rows[0];
        if (row?.owner_id === accountId) {
            throw httpError(400, 'OWNER_CANNOT_LEAVE', 'The owner removes a device by unpairing it');
        }
        const removed = row
            ? await client.query(
                `DELETE FROM device_memberships
                 WHERE device_id = $1 AND account_id = $2 AND role <> 'owner'
                 RETURNING account_id`,
                [row.id, accountId],
            )
            : { rows: [] };
        if (!removed.rows[0]) throw httpError(404, 'DEVICE_NOT_FOUND', 'Device not found');
        await recordAudit(client, {
            actorAccountId: accountId,
            deviceId: row.id,
            action: 'sharing.left',
            metadata: { device_name: row.name },
        });
        return queueAccessProjection(client, app.catalog, row.id, [accountId]);
    });
    await publishAccessChanges(app, [change]);
}
