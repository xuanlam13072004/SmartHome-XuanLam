'use strict';

/**
 * Factory tool for physical devices: registers the device's broker identity
 * and prints the generated MQTT password once, to be written into the
 * device's NVS (namespace "factory", key "mqttPassword").
 *
 * Usage:
 *   MQTT_BROKER_URL=mqtt://<broker>:1883 \
 *   MQTT_FACTORY_PASSWORD=... \
 *   node src/tools/provisionDeviceIdentity.js AA:BB:CC:DD:EE:FF
 *
 * Running it again for the same MAC rotates the password.
 * Use --revoke to delete the identity (also disconnects the device).
 */
const crypto = require('crypto');
const { DEVICE_ROLE, DynsecClient, assertResponses, ensureClient } = require('./dynsecClient');

const MAC_PATTERN = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;

async function main() {
    const args = process.argv.slice(2);
    const revoke = args.includes('--revoke');
    const mac = String(args.find(arg => !arg.startsWith('--')) || '').trim().toUpperCase();
    if (!MAC_PATTERN.test(mac)) throw new Error('Usage: provisionDeviceIdentity.js <MAC> [--revoke]');
    const factoryPassword = process.env.MQTT_FACTORY_PASSWORD;
    if (!factoryPassword) throw new Error('MQTT_FACTORY_PASSWORD is required');

    const dynsec = await DynsecClient.connect({
        url: process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883',
        username: process.env.MQTT_FACTORY_USERNAME || 'device-factory',
        password: factoryPassword,
    });
    try {
        if (revoke) {
            assertResponses(await dynsec.send([{ command: 'deleteClient', username: mac }]), ['Client not found']);
            process.stdout.write(`Revoked MQTT identity ${mac}\n`);
            return;
        }
        const password = crypto.randomBytes(32).toString('base64url');
        const result = await ensureClient(dynsec, { username: mac, password, roles: [DEVICE_ROLE] });
        process.stdout.write(`${result} MQTT identity ${mac}\nmqttPassword=${password}\n`);
    } finally {
        await dynsec.close();
    }
}

main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
});
