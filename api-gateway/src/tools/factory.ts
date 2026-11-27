/**
 * MQTT login of a physical device (docs/architecture/mqtt-security.md), inside
 * the Gateway container:
 *
 *   docker compose exec api-gateway node dist/tools/factory.js mqtt-password AA:BB:CC:DD:EE:FF
 *   docker compose exec api-gateway node dist/tools/factory.js mqtt-revoke AA:BB:CC:DD:EE:FF
 *
 * mqtt-password prints a new password once (write it into the device's NVS,
 * namespace "factory", key "mqttPassword"); running it again rotates it.
 * mqtt-revoke removes the login: the device can no longer connect (a session
 * already open ends at its next reconnect). The device must have a factory
 * record (factory_devices); virtual devices get theirs through the factory API.
 */
import { Pool } from 'pg';
import { env } from '../config/env';
import { revokeDeviceMqttLogin, setDeviceMqttPassword } from '../modules/factory/service';

const MAC_PATTERN = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;

async function main() {
    const [command, macInput] = process.argv.slice(2);
    const mac = String(macInput || '').trim().toUpperCase();
    if (!['mqtt-password', 'mqtt-revoke'].includes(command) || !MAC_PATTERN.test(mac)) {
        console.log('Usage: factory.js mqtt-password <MAC> | mqtt-revoke <MAC>');
        process.exitCode = 1;
        return;
    }
    const pg = new Pool({
        host: env.PG_HOST, port: env.PG_PORT, database: env.PG_DATABASE, user: env.PG_USER, password: env.PG_PASSWORD,
        ssl: env.PG_SSL ? { rejectUnauthorized: false } : false, max: 1,
    });
    try {
        if (command === 'mqtt-password') {
            const password = await setDeviceMqttPassword(pg, mac);
            console.log(`MQTT login của ${mac} đã được đặt (mật khẩu cũ, nếu có, không còn dùng được).`);
            console.log(`mqttPassword=${password}`);
        } else {
            const removed = await revokeDeviceMqttLogin(pg, mac);
            console.log(removed ? `Đã thu hồi MQTT login của ${mac}.` : `${mac} không có MQTT login.`);
        }
    } finally {
        await pg.end();
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
