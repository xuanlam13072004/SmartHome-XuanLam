'use strict';

const crypto = require('crypto');
const mqtt = require('mqtt');

const CONTROL_TOPIC = '$CONTROL/dynamic-security/v1';
const RESPONSE_TOPIC = `${CONTROL_TOPIC}/response`;

/**
 * Minimal client for the Mosquitto Dynamic Security control API.
 *
 * Commands are sent as one control message per call. The plugin persists its
 * JSON configuration once per control message, so callers should batch
 * commands instead of sending them one by one.
 */
class DynsecClient {
    constructor(client, timeoutMs) {
        this.client = client;
        this.timeoutMs = timeoutMs;
        this.pending = new Map();
        client.on('message', (topic, payload) => {
            if (topic !== RESPONSE_TOPIC) return;
            let message;
            try {
                message = JSON.parse(payload.toString());
            } catch {
                return;
            }
            const responses = Array.isArray(message.responses) ? message.responses : [];
            const correlation = responses[0]?.correlationData;
            const pending = correlation && this.pending.get(correlation);
            if (!pending) return;
            this.pending.delete(correlation);
            clearTimeout(pending.timer);
            pending.resolve(responses);
        });
    }

    static async connect({ url, username, password, clientId, timeoutMs = 10000 }) {
        const client = mqtt.connect(url, {
            username,
            password,
            clientId: clientId || `dynsec-${process.pid}-${crypto.randomUUID()}`,
            clean: true,
            reconnectPeriod: 0,
            connectTimeout: timeoutMs,
        });
        await new Promise((resolve, reject) => {
            client.once('connect', resolve);
            client.once('error', reject);
            client.once('close', () => reject(new Error('MQTT connection closed before CONNACK')));
        });
        await client.subscribeAsync(RESPONSE_TOPIC, { qos: 1 });
        return new DynsecClient(client, timeoutMs);
    }

    /** Sends commands in one control message and returns the per-command responses. */
    async send(commands) {
        if (commands.length === 0) return [];
        const correlation = crypto.randomUUID();
        const tagged = commands.map((command, index) => ({
            ...command,
            correlationData: index === 0 ? correlation : `${correlation}:${index}`,
        }));
        const responses = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(correlation);
                reject(new Error('Dynamic Security did not respond (check the admin role and broker plugin)'));
            }, this.timeoutMs);
            this.pending.set(correlation, { resolve, timer });
        });
        await this.client.publishAsync(CONTROL_TOPIC, JSON.stringify({ commands: tagged }), { qos: 1 });
        return responses;
    }

    async close() {
        for (const pending of this.pending.values()) clearTimeout(pending.timer);
        this.pending.clear();
        await this.client.endAsync();
    }
}

/** Throws unless every response succeeded or failed with an allowed error. */
function assertResponses(responses, allowedErrors = []) {
    for (const response of responses) {
        if (response.error && !allowedErrors.includes(response.error)) {
            throw new Error(`Dynamic Security ${response.command} failed: ${response.error}`);
        }
    }
}

const DEVICE_ROLE = 'smarthome-device';
const BACKEND_ROLE = 'smarthome-backend';

const allow = (acltype, topic) => ({ acltype, topic, priority: 0, allow: true });

/** Topic ACL contract, see docs/architecture/mqtt-security.md. */
const ROLE_ACLS = {
    [DEVICE_ROLE]: [
        allow('publishClientSend', 'smarthome/%u/telemetry'),
        allow('publishClientSend', 'smarthome/%u/events'),
        allow('publishClientSend', 'smarthome/%u/ack'),
        allow('publishClientSend', 'smarthome/%u/status'),
        allow('publishClientSend', 'smarthome/%u/topology/ack'),
        allow('subscribePattern', 'smarthome/%u/control'),
        allow('subscribePattern', 'smarthome/%u/hub/control'),
        allow('subscribePattern', 'smarthome/%u/topology'),
    ],
    [BACKEND_ROLE]: [
        allow('publishClientSend', 'smarthome/#'),
        allow('subscribePattern', 'smarthome/#'),
        allow('subscribePattern', '$share/+/smarthome/#'),
    ],
};

/**
 * Creates the client or, when it already exists, sets its password and
 * replaces its roles with `roles`. Safe to repeat.
 */
async function ensureClient(dynsec, { username, password, roles }) {
    const roleList = roles.map(rolename => ({ rolename, priority: 0 }));
    const [created] = await dynsec.send([{ command: 'createClient', username, password, roles: roleList }]);
    if (!created.error) return 'created';
    if (created.error !== 'Client already exists') {
        throw new Error(`Dynamic Security createClient failed for ${username}: ${created.error}`);
    }
    assertResponses(await dynsec.send([{ command: 'modifyClient', username, password, roles: roleList }]));
    return 'updated';
}

module.exports = {
    BACKEND_ROLE,
    DEVICE_ROLE,
    DynsecClient,
    ROLE_ACLS,
    assertResponses,
    ensureClient,
};
