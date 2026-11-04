'use strict';

/**
 * Idempotent bootstrap of the broker's Dynamic Security configuration.
 * Run by the `mqtt-initialize` Compose service after Mosquitto is healthy.
 *
 * Required environment:
 *   MQTT_BROKER_URL, MQTT_ADMIN_PASSWORD,
 *   MQTT_WORKER_USERNAME (default mqtt-worker-service), MQTT_WORKER_PASSWORD,
 *   MQTT_FACTORY_USERNAME (default device-factory), MQTT_FACTORY_PASSWORD
 */
const {
    BACKEND_ROLE,
    DynsecClient,
    ROLE_ACLS,
    assertResponses,
    ensureClient,
} = require('./dynsecClient');

function required(name) {
    const value = process.env[name];
    if (!value || value.length < 16) {
        throw new Error(`${name} must be set to a secret of at least 16 characters`);
    }
    return value;
}

async function initializeBroker(dynsec, settings) {
    for (const [rolename, acls] of Object.entries(ROLE_ACLS)) {
        assertResponses(await dynsec.send([{ command: 'createRole', rolename }]), ['Role already exists']);
        assertResponses(
            await dynsec.send(acls.map(acl => ({ command: 'addRoleACL', rolename, ...acl }))),
            ['ACL with this topic already exists'],
        );
    }
    // Deny by default: only explicit role ACLs grant publish/subscribe.
    assertResponses(await dynsec.send([{
        command: 'setDefaultACLAccess',
        acls: [
            { acltype: 'publishClientSend', allow: false },
            { acltype: 'subscribe', allow: false },
        ],
    }]));
    const worker = await ensureClient(dynsec, {
        username: settings.workerUsername,
        password: settings.workerPassword,
        roles: [BACKEND_ROLE],
    });
    const factory = await ensureClient(dynsec, {
        username: settings.factoryUsername,
        password: settings.factoryPassword,
        roles: ['dynsec-admin'],
    });
    return { worker, factory };
}

async function main() {
    const dynsec = await DynsecClient.connect({
        url: process.env.MQTT_BROKER_URL || 'mqtt://mosquitto:1883',
        username: process.env.MQTT_ADMIN_USERNAME || 'admin',
        password: required('MQTT_ADMIN_PASSWORD'),
        clientId: 'mqtt-initialize',
    });
    try {
        const result = await initializeBroker(dynsec, {
            workerUsername: process.env.MQTT_WORKER_USERNAME || 'mqtt-worker-service',
            workerPassword: required('MQTT_WORKER_PASSWORD'),
            factoryUsername: process.env.MQTT_FACTORY_USERNAME || 'device-factory',
            factoryPassword: required('MQTT_FACTORY_PASSWORD'),
        });
        process.stdout.write(`MQTT Dynamic Security initialized: ${JSON.stringify(result)}\n`);
    } finally {
        await dynsec.close();
    }
}

if (require.main === module) {
    main().catch((error) => {
        process.stderr.write(`${error.stack || error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = { initializeBroker };
