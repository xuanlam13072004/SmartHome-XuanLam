import argon2 from 'argon2';
import crypto from 'crypto';
import { FastifyInstance } from 'fastify';
import { env } from '../../config/env';
// @ts-ignore - resolve JavaScript shared module in TS
import { validateValueAgainstSchema } from '../../../../shared/validation';
// @ts-ignore
import { REDIS_CHANNELS, COMMAND_STATUS, CACHE_PREFIXES } from '../../../../shared/constants';

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

        // Đọc thông tin thiết bị xuất xưởng
        const factoryResult = await client.query(
            'SELECT mac, secret_key, product_id, is_claimed FROM factory_devices WHERE mac = $1',
            [input.mac]
        );

        if (factoryResult.rows.length === 0) {
            throw buildError('Device not authentic', 404, 'DEVICE_NOT_AUTHENTIC');
        }

        const factory = factoryResult.rows[0];

        if (!factory.secret_key) {
            throw buildError('Device not authentic', 404, 'DEVICE_NOT_AUTHENTIC');
        }

        // Kiểm tra xem product_id có được hỗ trợ trong Catalog Cache không
        const product = app.catalogCache.getProduct(factory.product_id);
        if (!product) {
            throw buildError('Device product not supported in catalog', 400, 'INVALID_DEVICE_PRODUCT');
        }

        // Xác thực mã bí mật
        const valid = await argon2.verify(factory.secret_key, input.secret_key);
        if (!valid) {
            throw buildError('Device not authentic', 401, 'INVALID_DEVICE_SECRET');
        }

        // Cập nhật trạng thái claimed
        const claimResult = await client.query(
            'UPDATE factory_devices SET is_claimed = true WHERE mac = $1 AND is_claimed = false RETURNING mac, product_id',
            [input.mac]
        );

        if (claimResult.rows.length === 0) {
            throw buildError('Device already claimed', 409, 'DEVICE_ALREADY_CLAIMED');
        }

        const productId = claimResult.rows[0].product_id;
        const name = input.name ? input.name.trim() : null;

        // Ghi metadata quyền sở hữu vào PostgreSQL
        const insertResult = await client.query(
            `
            INSERT INTO device_metadata (owner_id, mac, name, product_id, gateway_id, is_active, created_at, updated_at)
            VALUES ($1, $2, $3, $4, NULL, true, NOW(), NOW())
            RETURNING id, owner_id, mac, name, product_id, gateway_id, is_active, created_at, updated_at
            `,
            [ownerId, input.mac, name, productId]
        );

        // Khởi tạo Shadow State trong MongoDB với default_state của Product và diagnostics rỗng
        const collection = app.mongo.db.collection<any>(env.MONGO_DEVICES_COLLECTION);
        await collection.updateOne(
            { _id: input.mac },
            {
                $set: {
                    owner_id: ownerId,
                    product_id: productId,
                    name,
                    state: product.default_state || {},
                    diagnostics: {},
                    is_online: false,
                    last_updated: new Date(),
                },
            },
            { upsert: true }
        );

        await client.query('COMMIT');

        const device = insertResult.rows[0];

        // Xóa cache sở hữu cũ, cache product cũ và phát sự kiện xóa cache L1/L2
        try {
            await app.redis.del(`${CACHE_PREFIXES.OWNER_OF}${input.mac}`);
            await app.redis.del(`${CACHE_PREFIXES.PRODUCT_OF}${input.mac}`);
            await app.redis.publish(REDIS_CHANNELS.DEVICE_CONTEXT_INVALIDATED, input.mac);
        } catch (err) {
            app.log.warn({ err, mac: input.mac }, 'Failed to invalidate cache on claim');
        }

        // Ghi cache quyền sở hữu vào Redis L2
        try {
            const cacheKey = `${CACHE_PREFIXES.OWNER_OF}${input.mac}`;
            await app.redis.set(cacheKey, ownerId);
        } catch (err) {
            app.log.warn({ err, mac: input.mac }, 'Failed to cache device owner');
        }

        // Xóa danh sách thiết bị cũ trong cache của User
        try {
            const userDevicesKey = `user_devices:${ownerId}`;
            await app.redis.del(userDevicesKey);
        } catch (err) {
            app.log.warn({ err, ownerId }, 'Failed to invalidate user devices cache');
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
            'DELETE FROM device_metadata WHERE owner_id = $1 AND mac = $2 RETURNING mac, product_id',
            [ownerId, mac]
        );

        if (deleteResult.rows.length === 0) {
            throw buildError('Device not found', 404, 'DEVICE_NOT_FOUND');
        }

        await client.query(
            'UPDATE factory_devices SET is_claimed = false WHERE mac = $1',
            [mac]
        );

        // Xóa thông tin sở hữu trong MongoDB Shadow
        const collection = app.mongo.db.collection<any>(env.MONGO_DEVICES_COLLECTION);
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

        await client.query('COMMIT');

        // Xóa cache sở hữu, cache product và phát sự kiện xóa cache L1/L2
        try {
            await app.redis.del(`${CACHE_PREFIXES.OWNER_OF}${mac}`);
            await app.redis.del(`${CACHE_PREFIXES.PRODUCT_OF}${mac}`);
            await app.redis.publish(REDIS_CHANNELS.DEVICE_CONTEXT_INVALIDATED, mac);
        } catch (err) {
            app.log.warn({ err, mac }, 'Failed to clear device cache and publish invalidation');
        }

        // Xóa danh sách cache thiết bị của user
        try {
            const userDevicesKey = `user_devices:${ownerId}`;
            await app.redis.del(userDevicesKey);
        } catch (err) {
            app.log.warn({ err, ownerId }, 'Failed to invalidate user devices cache');
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
    const userDevicesKey = `user_devices:${ownerId}`;
    let devices: any[] = [];

    // Step 1: Lấy danh sách từ cache Redis
    try {
        const cached = await app.redis.get(userDevicesKey);
        if (cached) {
            devices = JSON.parse(cached);
            app.log.debug({ ownerId }, 'User devices list resolved from cache');
        }
    } catch (err) {
        app.log.warn({ err, ownerId }, 'Failed to get user devices list from cache');
    }

    // Step 2: Cache miss -> Query Postgres
    if (devices.length === 0) {
        const result = await app.pg.query(
            `
            SELECT id, owner_id, mac, name, product_id, gateway_id, is_active, created_at, updated_at
            FROM device_metadata
            WHERE owner_id = $1
            ORDER BY created_at DESC
            `,
            [ownerId]
        );
        devices = result.rows;

        if (devices.length > 0) {
            try {
                await app.redis.setex(
                    userDevicesKey,
                    env.REDIS_CACHE_TTL_SECONDS,
                    JSON.stringify(devices)
                );
                app.log.debug({ ownerId }, 'User devices list cached in Redis');
            } catch (err) {
                app.log.warn({ err, ownerId }, 'Failed to cache user devices list');
            }
        }
    }

    const macs = devices.map(d => d.mac);
    if (macs.length === 0) {
        return [];
    }

    // Step 3: Ghép nối shadow state và diagnostics từ MongoDB
    try {
        const collection = app.mongo.db.collection<any>(env.MONGO_DEVICES_COLLECTION);
        const shadows = await collection.find({ _id: { $in: macs } }).toArray();
        const shadowMap = new Map(shadows.map(s => [s._id, s]));

        return devices.map(d => {
            const shadow = shadowMap.get(d.mac);
            return {
                ...d,
                state: shadow?.state || {},
                diagnostics: shadow?.diagnostics || {},
                is_online: shadow?.is_online ?? false,
                rssi: shadow?.diagnostics?.rssi ?? null,
                battery: shadow?.diagnostics?.battery ?? null,
                last_seen: shadow?.last_seen ?? null,
            };
        });
    } catch (err) {
        app.log.error({ err, ownerId }, 'Failed to merge MongoDB device shadow states');
        return devices.map(d => ({
            ...d,
            state: {},
            diagnostics: {},
            is_online: false,
            rssi: null,
            battery: null,
            last_seen: null,
        }));
    }
}

export async function sendDeviceCommand(app: FastifyInstance, input: {
    mac: string;
    action: string;
    instance?: string;
    payload?: Record<string, unknown>;
}, ownerId: string) {
    // 1. Kiểm tra quyền sở hữu và lấy product_id của thiết bị
    const deviceResult = await app.pg.query(
        'SELECT product_id FROM device_metadata WHERE owner_id = $1 AND mac = $2 AND is_active = true',
        [ownerId, input.mac]
    );

    if (deviceResult.rows.length === 0) {
        throw buildError('Device not found', 404, 'DEVICE_NOT_FOUND');
    }

    const productId = deviceResult.rows[0].product_id;

    // 2. Tra cứu compiled product từ Catalog Cache
    const product = app.catalogCache.getProduct(productId);
    if (!product) {
        throw buildError('Product catalog metadata not loaded', 500, 'PRODUCT_CATALOG_MISSING');
    }

    // 3. Kiểm tra xem action có nằm trong allowedCommandActions của sản phẩm không
    const instancesMap = product.allowedCommandActions.get(input.action);
    if (!instancesMap) {
        throw buildError(`Command '${input.action}' is not supported by product '${productId}'`, 400, 'UNSUPPORTED_COMMAND_ACTION');
    }

    let compiledCommand: any | undefined;
    const instance = input.instance;

    if (instance) {
        compiledCommand = instancesMap.get(instance);
        if (!compiledCommand) {
            throw buildError(`Instance '${instance}' is not supported for action '${input.action}'`, 400, 'UNSUPPORTED_INSTANCE');
        }
    } else {
        // Tự động resolve nếu chỉ có duy nhất 1 instance
        if (instancesMap.size === 1) {
            compiledCommand = instancesMap.values().next().value;
        } else {
            throw buildError(`Multiple instances available for action '${input.action}'. 'instance' parameter is required.`, 400, 'INSTANCE_REQUIRED');
        }
    }

    // 4. Validate từng argument của lệnh dựa trên cấu hình biên dịch
    const payload = input.payload || {};
    const argsConfig = compiledCommand.arguments || [];

    for (const argSpec of argsConfig) {
        const val = payload[argSpec.name];
        const res = validateValueAgainstSchema(val, argSpec);
        if (!res.valid) {
            throw buildError(`Argument '${argSpec.name}' validation failed: ${res.error}`, 400, 'COMMAND_ARGUMENT_INVALID');
        }
    }

    const commandId = crypto.randomUUID();
    const commandPayload = {
        command_id: commandId,
        owner_id: ownerId,
        device_id: input.mac,
        capability_id: compiledCommand.capability_id,
        action: input.action,
        instance: compiledCommand.instance,
        payload: payload,
        timestamp: new Date().toISOString(),
    };

    // 5. Ghi nhận lệnh trạng thái pending vào Postgres
    await app.pg.query(
        `
        INSERT INTO device_commands (id, owner_id, mac, command, status, retry_count, event_version, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, 0, 1, NOW(), NOW())
        `,
        [commandId, ownerId, input.mac, JSON.stringify(commandPayload), COMMAND_STATUS.PENDING]
    );

    // 6. Ghi nhận lệnh vào MongoDB active_commands phục vụ recovery
    try {
        const activeCommandsCol = app.mongo.db.collection<any>('active_commands');
        await activeCommandsCol.insertOne({
            _id: commandId,
            owner_id: ownerId,
            mac: input.mac,
            command: JSON.stringify(commandPayload),
            status: COMMAND_STATUS.PENDING,
            event_version: 1,
            created_at: new Date(),
            updated_at: new Date()
        });
    } catch (mongoErr) {
        app.log.warn({ mongoErr, commandId }, 'Failed to insert active command into MongoDB');
    }

    // 7. Đẩy lệnh vào Redis Stream
    const pipeline = app.redis.pipeline();
    pipeline.set(`command_version:${commandId}`, '1', 'EX', 600);
    pipeline.xadd(
        env.REDIS_COMMAND_STREAM,
        '*',
        'data',
        JSON.stringify(commandPayload)
    );
    await pipeline.exec();

    return {
        command_id: commandId,
        status: COMMAND_STATUS.PENDING,
    };
}

export async function getDeviceState(app: FastifyInstance, mac: string, ownerId: string) {
    const ownership = await app.pg.query(
        'SELECT 1 FROM device_metadata WHERE owner_id = $1 AND mac = $2',
        [ownerId, mac]
    );

    if (ownership.rows.length === 0) {
        throw buildError('Forbidden', 403, 'DEVICE_FORBIDDEN');
    }

    const collection = app.mongo.db.collection<any>(env.MONGO_DEVICES_COLLECTION);
    const shadow = await collection.findOne({ _id: mac });

    if (!shadow) {
        return {
            is_online: false,
            state: {},
            diagnostics: {},
        };
    }

    return {
        state: shadow.state || {},
        diagnostics: shadow.diagnostics || {},
        is_online: Boolean(shadow.is_online),
        rssi: shadow.diagnostics?.rssi ?? null,
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
        RETURNING id, owner_id, mac, name, product_id, gateway_id, is_active, created_at, updated_at
        `,
        [trimmedName, ownerId, mac]
    );

    if (result.rows.length === 0) {
        throw buildError('Device not found', 404, 'DEVICE_NOT_FOUND');
    }

    try {
        const collection = app.mongo.db.collection<any>(env.MONGO_DEVICES_COLLECTION);
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

    try {
        const userDevicesKey = `user_devices:${ownerId}`;
        await app.redis.del(userDevicesKey);
    } catch (err) {
        app.log.warn({ err, ownerId }, 'Failed to invalidate user devices cache');
    }

    return result.rows[0];
}

export async function syncOwnershipToRedis(app: FastifyInstance) {
    app.log.info('Starting synchronization of device ownership from PostgreSQL to Redis...');
    try {
        const result = await app.pg.query(
            'SELECT mac, owner_id FROM device_metadata WHERE is_active = true'
        );

        if (result.rows.length === 0) {
            app.log.info('No active devices found in PostgreSQL to sync.');
            return;
        }

        const pipeline = app.redis.pipeline();
        for (const row of result.rows) {
            const cacheKey = `${CACHE_PREFIXES.OWNER_OF}${row.mac}`;
            pipeline.set(cacheKey, row.owner_id);
        }
        await pipeline.exec(); // Wait, let's make sure we write pipeline.exec()!
    } catch (err) {
        app.log.error({ err }, 'Failed to synchronize device ownership to Redis on startup');
    }
}
