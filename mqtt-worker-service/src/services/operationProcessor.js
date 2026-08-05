'use strict';

const { z } = require('zod');
const { validateObjectAgainstSchema } = require('../../../shared/validation');
const {
    resolveOperationRoute,
    storeOperationRoute,
    deleteOperationRoute,
} = require('./topologyRuntime');

const operationSchema = z.object({
    schema: z.literal('device.operation.v2'),
    operation_id: z.string().uuid(),
    owner_id: z.string().uuid(),
    device_id: z.string().transform(value => value.trim().toUpperCase()),
    product_id: z.string().regex(/^prod_[a-z0-9_]+$/),
    catalog_revision: z.coerce.number().int().positive(),
    instance_id: z.string().regex(/^[a-z][a-z0-9_]+$/),
    operation_name: z.string().regex(/^[a-z][a-z0-9_]+$/),
    input: z.record(z.any()).default({}),
    context: z.record(z.any()).default({}),
    created_at: z.string().datetime(),
    timeout_at: z.string().datetime(),
});

function validateOperation(message) {
    return operationSchema.parse(message);
}

async function updateOperationStatus(
    redis,
    config,
    operationId,
    status,
    reasonCode = null,
    details = {},
) {
    await redis.xadd(
        config.REDIS_OPERATION_STATUS_STREAM,
        '*',
        'data',
        JSON.stringify({
            operation_id: operationId,
            status,
            reason_code: reasonCode,
            details,
        }),
    );
}

function publishOperationToDevice(mqttClient, operation, route, config, logger) {
    const topic = route.mode === 'relay'
        ? config.MQTT_HUB_CONTROL_TOPIC
            .replace('{hub_id}', route.publish_device_id)
            .replace('{device_id}', route.publish_device_id)
        : config.MQTT_CONTROL_TOPIC.replace('{device_id}', route.publish_device_id);
    const payload = {
        schema: 'device.operation.v2',
        operation_id: operation.operation_id,
        target_device_id: route.target_device_id,
        product_id: operation.product_id,
        catalog_revision: operation.catalog_revision,
        instance_id: operation.instance_id,
        operation_name: operation.operation_name,
        input: operation.input,
        context: operation.context,
        issued_at: new Date().toISOString(),
        timeout_at: operation.timeout_at,
        route: {
            mode: route.mode,
            network_id: route.network_id,
            topology_epoch: route.topology_epoch,
            hub_mac: route.hub_mac,
        },
    };
    return new Promise((resolve, reject) => {
        mqttClient.publish(topic, JSON.stringify(payload), { qos: config.MQTT_QOS }, error => {
            if (error) reject(error);
            else {
                logger.info(
                    {
                        operation_id: operation.operation_id,
                        operation_name: operation.operation_name,
                        route_mode: route.mode,
                    },
                    'Operation published to device',
                );
                resolve();
            }
        });
    });
}

async function acquireOperation(redis, operationId, config) {
    const result = await redis.eval(
        `if redis.call('exists', KEYS[1]) == 1 then return 2 end
         if redis.call('set', KEYS[2], '1', 'EX', ARGV[1], 'NX') then return 1 end
         return 0`,
        2,
        `operation:published:${operationId}`,
        `operation:processing:${operationId}`,
        config.OPERATION_PROCESSING_TTL_SECONDS,
    );
    if (Number(result) === 2) return 'published';
    if (Number(result) === 1) return 'acquired';
    return 'busy';
}

async function processOperation(rawMessage, clients, config, logger) {
    const operation = validateOperation(rawMessage);
    if (new Date(operation.timeout_at).getTime() <= Date.now()) {
        await updateOperationStatus(
            clients.redis,
            config,
            operation.operation_id,
            'timed_out',
            'OPERATION_EXPIRED_BEFORE_DISPATCH',
        );
        return operation.operation_id;
    }

    const product = clients.catalog.getProduct(operation.product_id);
    const definition = clients.catalog.getOperation(
        operation.product_id,
        operation.instance_id,
        operation.operation_name,
    );
    if (!product || product.catalog_revision !== operation.catalog_revision || !definition) {
        await updateOperationStatus(
            clients.redis,
            config,
            operation.operation_id,
            'rejected',
            'OPERATION_CONTRACT_UNAVAILABLE',
        );
        return operation.operation_id;
    }
    const validation = validateObjectAgainstSchema(operation.input, definition.input || {});
    if (!validation.valid) {
        await updateOperationStatus(
            clients.redis,
            config,
            operation.operation_id,
            'rejected',
            'OPERATION_INPUT_INVALID',
            { error: validation.error },
        );
        return operation.operation_id;
    }

    const acquired = await acquireOperation(
        clients.redis,
        operation.operation_id,
        config,
    );
    if (acquired === 'published') return operation.operation_id;
    if (acquired === 'busy') {
        const error = new Error('Operation is being processed by another worker');
        error.retryable = true;
        throw error;
    }

    const processingKey = `operation:processing:${operation.operation_id}`;
    try {
        const route = await resolveOperationRoute(clients.redis, operation, config);
        await storeOperationRoute(
            clients.redis,
            operation.operation_id,
            route,
            config,
        );
        await updateOperationStatus(
            clients.redis,
            config,
            operation.operation_id,
            'executing',
        );
        await publishOperationToDevice(
            clients.mqttClient,
            operation,
            route,
            config,
            logger,
        );
        await clients.redis
            .multi()
            .set(
                `operation:published:${operation.operation_id}`,
                '1',
                'EX',
                config.OPERATION_IDEMPOTENCY_TTL_SECONDS,
            )
            .del(processingKey)
            .exec();
        return operation.operation_id;
    } catch (error) {
        await clients.redis.del(processingKey).catch(() => undefined);
        if (error?.retryable === false) {
            await deleteOperationRoute(clients.redis, operation.operation_id).catch(() => undefined);
            await updateOperationStatus(
                clients.redis,
                config,
                operation.operation_id,
                'rejected',
                error.code || 'OPERATION_ROUTING_REJECTED',
            );
            return operation.operation_id;
        }
        throw error;
    }
}

module.exports = {
    acquireOperation,
    processOperation,
    publishOperationToDevice,
    updateOperationStatus,
    validateOperation,
};
