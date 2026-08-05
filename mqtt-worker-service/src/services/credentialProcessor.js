'use strict';

const { z } = require('zod');
const { resolveOperationRoute, storeOperationRoute } = require('./topologyRuntime');

const credentialSchema = z.object({
    schema: z.literal('device.credential.v2'),
    job_id: z.string().uuid(),
    owner_id: z.string().uuid(),
    actor_account_id: z.string().uuid(),
    device_id: z.string().transform(value => value.trim().toUpperCase()),
    product_id: z.string().regex(/^prod_[a-z0-9_]+$/),
    catalog_revision: z.coerce.number().int().positive(),
    instance_id: z.string().regex(/^[a-z][a-z0-9_]+$/),
    credential_name: z.string().regex(/^[a-z][a-z0-9_]+$/),
    action: z.literal('replace'),
    encrypted_envelope: z.object({
        algorithm: z.literal('RSA-OAEP-256+A256GCM'),
        encrypted_key_base64: z.string().min(1),
        iv_base64: z.string().min(1),
        ciphertext_base64: z.string().min(1),
        auth_tag_base64: z.string().min(1),
    }),
    created_at: z.string().datetime(),
    timeout_at: z.string().datetime(),
});

async function updateCredentialStatus(redis, config, jobId, status, reasonCode = null) {
    await redis.xadd(
        config.REDIS_CREDENTIAL_STATUS_STREAM,
        '*',
        'data',
        JSON.stringify({ job_id: jobId, status, reason_code: reasonCode }),
    );
}

async function processCredential(rawMessage, clients, config, logger) {
    const credential = credentialSchema.parse(rawMessage);
    if (new Date(credential.timeout_at).getTime() <= Date.now()) {
        await updateCredentialStatus(
            clients.redis, config, credential.job_id, 'timed_out',
            'CREDENTIAL_EXPIRED_BEFORE_DISPATCH',
        );
        return credential.job_id;
    }
    const product = clients.catalog.getProduct(credential.product_id);
    const definition = clients.catalog.getCredential(
        credential.product_id,
        credential.instance_id,
        credential.credential_name,
    );
    if (!product || product.catalog_revision !== credential.catalog_revision || !definition) {
        await updateCredentialStatus(
            clients.redis, config, credential.job_id, 'rejected',
            'CREDENTIAL_CONTRACT_UNAVAILABLE',
        );
        return credential.job_id;
    }

    const acquired = await clients.redis.set(
        `credential:published:${credential.job_id}`,
        '1',
        'EX',
        config.OPERATION_IDEMPOTENCY_TTL_SECONDS,
        'NX',
    );
    if (!acquired) return credential.job_id;
    const route = await resolveOperationRoute(clients.redis, credential, config);
    await storeOperationRoute(clients.redis, credential.job_id, route, config);
    const topic = route.mode === 'relay'
        ? config.MQTT_HUB_CONTROL_TOPIC
            .replace('{hub_id}', route.publish_device_id)
            .replace('{device_id}', route.publish_device_id)
        : config.MQTT_CONTROL_TOPIC.replace('{device_id}', route.publish_device_id);
    const payload = {
        schema: credential.schema,
        job_id: credential.job_id,
        target_device_id: route.target_device_id,
        product_id: credential.product_id,
        catalog_revision: credential.catalog_revision,
        instance_id: credential.instance_id,
        credential_name: credential.credential_name,
        action: credential.action,
        encrypted_envelope: credential.encrypted_envelope,
        issued_at: new Date().toISOString(),
        timeout_at: credential.timeout_at,
        route: {
            mode: route.mode,
            network_id: route.network_id,
            topology_epoch: route.topology_epoch,
            hub_mac: route.hub_mac,
        },
    };
    await new Promise((resolve, reject) => {
        clients.mqttClient.publish(topic, JSON.stringify(payload), { qos: config.MQTT_QOS }, error => {
            if (error) reject(error);
            else resolve();
        });
    });
    logger.info({ job_id: credential.job_id, route_mode: route.mode }, 'Credential envelope published');
    return credential.job_id;
}

module.exports = {
    credentialSchema,
    processCredential,
    updateCredentialStatus,
};
