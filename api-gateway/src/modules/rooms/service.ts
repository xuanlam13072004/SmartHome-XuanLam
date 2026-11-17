import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { env } from '../../config/env';
import { httpError } from '../../utils/httpError';

export interface RoomView {
    id: string;
    name: string;
    icon: string;
    position: number;
    device_count: number;
}

async function inTransaction<T>(app: FastifyInstance, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await app.pg.connect();
    try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
    } catch (error: any) {
        await client.query('ROLLBACK');
        if (error?.code === '23505') throw httpError(409, 'ROOM_NAME_TAKEN', 'A room with this name already exists');
        throw error;
    } finally {
        client.release();
    }
}

/** Serialises room changes of one account so the limit and positions stay exact. */
async function lockAccount(client: PoolClient, accountId: string) {
    const result = await client.query(`SELECT 1 FROM accounts WHERE id = $1 AND status = 'active' FOR UPDATE`, [accountId]);
    if (!result.rows[0]) throw httpError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
}

function limitError() {
    return httpError(409, 'ROOM_LIMIT_REACHED', `An account can have at most ${env.MAX_ROOMS_PER_ACCOUNT} rooms`);
}

/** The account's rooms in display order, each with how many of its visible devices it holds. */
export async function listRooms(app: FastifyInstance, accountId: string): Promise<RoomView[]> {
    const result = await app.pg.query(
        `SELECT room.id, room.name, room.icon, room.position,
                count(device.id)::int AS device_count
         FROM rooms AS room
         LEFT JOIN device_memberships AS membership
           ON membership.room_id = room.id AND membership.account_id = room.account_id
          AND membership.status = 'active'
          AND (membership.expires_at IS NULL OR membership.expires_at > NOW())
         LEFT JOIN device_metadata AS device
           ON device.id = membership.device_id AND device.is_active = true
         WHERE room.account_id = $1
         GROUP BY room.id
         ORDER BY room.position, room.created_at`,
        [accountId],
    );
    return result.rows;
}

export async function createRoom(app: FastifyInstance, accountId: string, input: { name: string; icon: string }) {
    return inTransaction(app, async (client) => {
        await lockAccount(client, accountId);
        const stats = await client.query(
            `SELECT count(*)::int AS count, COALESCE(max(position) + 1, 0) AS next
             FROM rooms WHERE account_id = $1`,
            [accountId],
        );
        if (stats.rows[0].count >= env.MAX_ROOMS_PER_ACCOUNT) throw limitError();
        const inserted = await client.query(
            `INSERT INTO rooms (account_id, name, icon, position) VALUES ($1, $2, $3, $4)
             RETURNING id, name, icon, position`,
            [accountId, input.name, input.icon, stats.rows[0].next],
        );
        return { ...inserted.rows[0], device_count: 0 } as RoomView;
    });
}

export async function updateRoom(
    app: FastifyInstance,
    accountId: string,
    roomId: string,
    input: { name?: string; icon?: string },
) {
    return inTransaction(app, async (client) => {
        const updated = await client.query(
            `UPDATE rooms SET name = COALESCE($3, name), icon = COALESCE($4, icon)
             WHERE id = $1 AND account_id = $2
             RETURNING id, name, icon, position`,
            [roomId, accountId, input.name ?? null, input.icon ?? null],
        );
        if (!updated.rows[0]) throw httpError(404, 'ROOM_NOT_FOUND', 'Room not found');
        return updated.rows[0];
    });
}

/** Deleting a room never deletes devices: they become "Chưa xếp phòng". */
export async function deleteRoom(app: FastifyInstance, accountId: string, roomId: string) {
    const result = await app.pg.query(
        'DELETE FROM rooms WHERE id = $1 AND account_id = $2 RETURNING id',
        [roomId, accountId],
    );
    if (!result.rows[0]) throw httpError(404, 'ROOM_NOT_FOUND', 'Room not found');
}

/** `roomIds` must list every room of the account exactly once, in the new order. */
export async function reorderRooms(app: FastifyInstance, accountId: string, roomIds: string[]) {
    await inTransaction(app, async (client) => {
        await lockAccount(client, accountId);
        const existing = await client.query('SELECT id FROM rooms WHERE account_id = $1', [accountId]);
        const known = new Set(existing.rows.map(row => row.id as string));
        const requested = new Set(roomIds);
        if (requested.size !== roomIds.length || requested.size !== known.size
            || roomIds.some(id => !known.has(id))) {
            throw httpError(400, 'ROOM_ORDER_MISMATCH', 'The order must list every room exactly once');
        }
        await client.query(
            `UPDATE rooms AS room SET position = ordered.position - 1
             FROM unnest($2::uuid[]) WITH ORDINALITY AS ordered(id, position)
             WHERE room.id = ordered.id AND room.account_id = $1`,
            [accountId, roomIds],
        );
    });
}

/** Puts one of the caller's visible devices into one of the caller's rooms (or none). */
export async function setDeviceRoom(app: FastifyInstance, accountId: string, mac: string, roomId: string | null) {
    try {
        const result = await app.pg.query(
            `UPDATE device_memberships AS membership SET room_id = $3
             FROM device_metadata AS device
             WHERE device.id = membership.device_id AND device.mac = $2 AND device.is_active = true
               AND membership.account_id = $1 AND membership.status = 'active'
               AND (membership.expires_at IS NULL OR membership.expires_at > NOW())
             RETURNING membership.room_id`,
            [accountId, mac, roomId],
        );
        if (!result.rows[0]) throw httpError(404, 'DEVICE_NOT_FOUND', 'Device not found');
        return { mac, room_id: result.rows[0].room_id as string | null };
    } catch (error: any) {
        // The composite foreign key rejects rooms that are not the caller's.
        if (error?.code === '23503') throw httpError(404, 'ROOM_NOT_FOUND', 'Room not found');
        throw error;
    }
}

/**
 * Applies the suggested layout in one step: creates each room (or reuses the
 * one with the same name, compared the way the unique index compares) and
 * moves the listed devices into it. Devices the caller cannot see are skipped.
 */
export async function setupRooms(
    app: FastifyInstance,
    accountId: string,
    rooms: Array<{ name: string; icon: string; devices: string[] }>,
) {
    await inTransaction(app, async (client) => {
        await lockAccount(client, accountId);
        const stats = await client.query(
            `SELECT count(*)::int AS count, COALESCE(max(position) + 1, 0) AS next
             FROM rooms WHERE account_id = $1`,
            [accountId],
        );
        let count = Number(stats.rows[0].count);
        let next = Number(stats.rows[0].next);
        for (const room of rooms) {
            const found = await client.query(
                `SELECT id FROM rooms WHERE account_id = $1 AND lower(btrim(name)) = lower(btrim($2))`,
                [accountId, room.name],
            );
            let id = found.rows[0]?.id as string | undefined;
            if (!id) {
                if (count >= env.MAX_ROOMS_PER_ACCOUNT) throw limitError();
                const inserted = await client.query(
                    `INSERT INTO rooms (account_id, name, icon, position) VALUES ($1, $2, $3, $4) RETURNING id`,
                    [accountId, room.name, room.icon, next],
                );
                id = inserted.rows[0].id as string;
                count += 1;
                next += 1;
            }
            if (room.devices.length > 0) {
                await client.query(
                    `UPDATE device_memberships AS membership SET room_id = $3
                     FROM device_metadata AS device
                     WHERE device.id = membership.device_id AND device.mac = ANY($2::text[])
                       AND device.is_active = true
                       AND membership.account_id = $1 AND membership.status = 'active'
                       AND (membership.expires_at IS NULL OR membership.expires_at > NOW())`,
                    [accountId, room.devices, id],
                );
            }
        }
    });
    return listRooms(app, accountId);
}
