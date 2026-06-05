import argon2 from 'argon2';
import crypto from 'crypto';
import { FastifyInstance } from 'fastify';
import { env } from '../../config/env';
import { ALLOWED_ROLES, isAllowedRole } from './roles';

function buildError(message: string, statusCode: number, code: string) {
    const err = new Error(message) as any;
    err.statusCode = statusCode;
    err.code = code;
    return err;
}

export async function claimDevice(app: FastifyInstance, input: {
    mac: string;
    secret_key: string;
    name?: string;
}, ownerId: string) {
    const client = await app.pg.connect();

    try {
        await client.query('BEGIN');

        const factoryResult = await client.query(
            'SELECT mac, secret_key, role, is_claimed FROM factory_devices WHERE mac = $1',
            [input.mac]
        );

        if (factoryResult.rows.length === 0) {
            throw buildError('Device not authentic', 404, 'DEVICE_NOT_AUTHENTIC');
        }

        const factory = factoryResult.rows[0];

        if (!factory.secret_key) {
            throw buildError('Device not authentic', 404, 'DEVICE_NOT_AUTHENTIC');
        }

        if (!isAllowedRole(factory.role)) {
            throw buildError('Device role not supported', 400, 'INVALID_DEVICE_ROLE');
        }

        const valid = await argon2.verify(factory.secret_key, input.secret_key);

        if (!valid) {
            throw buildError('Device not authentic', 401, 'INVALID_DEVICE_SECRET');
        }

        const claimResult = await client.query(
            'UPDATE factory_devices SET is_claimed = true WHERE mac = $1 AND is_claimed = false RETURNING mac, role',
            [input.mac]
        );

        if (claimResult.rows.length === 0) {
            throw buildError('Device already claimed', 409, 'DEVICE_ALREADY_CLAIMED');
        }

        const role = claimResult.rows[0].role;
        const name = input.name ? input.name.trim() : null;

        const insertResult = await client.query(
            `
            INSERT INTO device_metadata (owner_id, mac, name, role, is_active, created_at, updated_at)
            VALUES ($1, $2, $3, $4, true, NOW(), NOW())
            RETURNING id, owner_id, mac, name, role, is_active, created_at, updated_at
            `,
            [ownerId, input.mac, name, role]
        );

        await client.query('COMMIT');

        const device = insertResult.rows[0];

        try {
            const cacheKey = `${env.REDIS_CACHE_OWNER_PREFIX}${input.mac}`;
            await app.redis.setex(cacheKey, env.REDIS_CACHE_TTL_SECONDS, ownerId);
        } catch (err) {
            app.log.warn({ err, mac: input.mac }, 'Failed to cache device owner');
        }

        try {
            const collection = app.mongo.db.collection(env.MONGO_DEVICES_COLLECTION);
            await collection.updateOne(
                { _id: input.mac },
                {
                    $set: {
                        owner_id: ownerId,
                        role,
                        name,
                        last_updated: new Date(),
                    },
                },
                { upsert: true }
            );
        } catch (err) {
            app.log.warn({ err, mac: input.mac }, 'Failed to update device shadow');
        }

        return device;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

export async function unpairDevice(app: FastifyInstance, mac: string, ownerId: string) {
    const client = await app.pg.connect();

    try {
        await client.query('BEGIN');

        const deleteResult = await client.query(
            'DELETE FROM device_metadata WHERE owner_id = $1 AND mac = $2 RETURNING mac, role',
            [ownerId, mac]
        );

        if (deleteResult.rows.length === 0) {
            throw buildError('Device not found', 404, 'DEVICE_NOT_FOUND');
        }

        await client.query(
            'UPDATE factory_devices SET is_claimed = false WHERE mac = $1',
            [mac]
        );

        await client.query('COMMIT');

        try {
            const cacheKey = `${env.REDIS_CACHE_OWNER_PREFIX}${mac}`;
            await app.redis.del(cacheKey);
        } catch (err) {
            app.log.warn({ err, mac }, 'Failed to clear device owner cache');
        }

        try {
            const collection = app.mongo.db.collection(env.MONGO_DEVICES_COLLECTION);
            await collection.updateOne(
                { _id: mac },
                {
                    $set: {
                        owner_id: null,
                        name: null,
                        last_updated: new Date(),
                    },
                }
            );
        } catch (err) {
            app.log.warn({ err, mac }, 'Failed to clear device shadow owner');
        }

        return { mac };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

export async function listDevices(app: FastifyInstance, ownerId: string) {
    const result = await app.pg.query(
        `
        SELECT id, owner_id, mac, name, role, is_active, created_at, updated_at
        FROM device_metadata
        WHERE owner_id = $1 AND role = ANY($2)
        ORDER BY created_at DESC
        `,
        [ownerId, ALLOWED_ROLES]
    );

    return result.rows;
}

export async function sendDeviceCommand(app: FastifyInstance, input: {
    mac: string;
    action: 'ON' | 'OFF' | 'SET_TEMP';
    payload?: Record<string, unknown>;
}, ownerId: string) {
    const deviceResult = await app.pg.query(
        'SELECT role FROM device_metadata WHERE owner_id = $1 AND mac = $2 AND is_active = true',
        [ownerId, input.mac]
    );

    if (deviceResult.rows.length === 0) {
        throw buildError('Device not found', 404, 'DEVICE_NOT_FOUND');
    }

    const commandId = crypto.randomUUID();
    const commandPayload = {
        command_id: commandId,
        owner_id: ownerId,
        device_id: input.mac,
        action: input.action,
        payload: input.payload || {},
        timestamp: new Date().toISOString(),
    };

    await app.pg.query(
        `
        INSERT INTO device_commands (id, owner_id, mac, command, status, retry_count, created_at, updated_at)
        VALUES ($1, $2, $3, $4, 'pending', 0, NOW(), NOW())
        `,
        [commandId, ownerId, input.mac, JSON.stringify(commandPayload)]
    );

    await app.redis.xadd(
        env.REDIS_COMMAND_STREAM,
        '*',
        'data',
        JSON.stringify(commandPayload)
    );

    return {
        command_id: commandId,
        status: 'pending',
    };
}

export async function getDeviceState(app: FastifyInstance, mac: string, ownerId: string) {
    const ownership = await app.pg.query(
        'SELECT 1 FROM device_metadata WHERE owner_id = $1 AND mac = $2',
        [ownerId, mac]
    );

    if (ownership.rows.length === 0) {
        const err = new Error('Forbidden') as any;
        err.statusCode = 403;
        err.code = 'DEVICE_FORBIDDEN';
        throw err;
    }

    const collection = app.mongo.db.collection(env.MONGO_DEVICES_COLLECTION);
    const shadow = await collection.findOne({ _id: mac });

    if (!shadow) {
        return {
            is_online: false,
            state: {},
        };
    }

    return {
        state: shadow.state || {},
        is_online: Boolean(shadow.is_online),
        rssi: shadow.rssi ?? null,
        last_updated: shadow.last_updated || null,
    };
}

export async function updateDeviceName(app: FastifyInstance, mac: string, name: string, ownerId: string) {
    const trimmedName = name.trim();

    const result = await app.pg.query(
        `
        UPDATE device_metadata
        SET name = $1, updated_at = NOW()
        WHERE owner_id = $2 AND mac = $3
        RETURNING id, owner_id, mac, name, role, is_active, created_at, updated_at
        `,
        [trimmedName, ownerId, mac]
    );

    if (result.rows.length === 0) {
        throw buildError('Device not found', 404, 'DEVICE_NOT_FOUND');
    }

    try {
        const collection = app.mongo.db.collection(env.MONGO_DEVICES_COLLECTION);
        await collection.updateOne(
            { _id: mac },
            {
                $set: {
                    name: trimmedName,
                    last_updated: new Date(),
                },
            }
        );
    } catch (err) {
        app.log.warn({ err, mac }, 'Failed to update device shadow name');
    }

    return result.rows[0];
}
