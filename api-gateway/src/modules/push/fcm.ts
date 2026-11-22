import crypto from 'node:crypto';
import fs from 'node:fs';
import { env } from '../../config/env';

/**
 * Firebase Cloud Messaging, HTTP v1 API. The Gateway signs its own OAuth
 * token with the project's service account (RS256 JWT, Google's documented
 * server-to-server flow), so no Firebase SDK is needed. Without the service
 * account file push is simply off.
 */

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

interface ServiceAccount {
    project_id: string;
    client_email: string;
    private_key: string;
    token_uri: string;
}

/** What a push carries; every data value is a string (FCM rule). */
export interface PushMessage {
    title: string;
    body: string;
    /** Where the app opens when the notification is tapped. */
    route: string;
    /** alerts: loud, heads-up (fire, gas, security); general: everything else. */
    channel: 'alerts' | 'general';
    /** A newer push with the same tag replaces the older one in the tray. */
    tag?: string;
    data?: Record<string, string>;
}

export type SendResult = 'sent' | 'invalid_token' | 'failed';

let account: ServiceAccount | null | undefined;
let accessToken: { value: string; expiresAt: number } | null = null;

function loadAccount(): ServiceAccount | null {
    if (account !== undefined) return account;
    account = null;
    if (!env.FCM_SERVICE_ACCOUNT_FILE) return account;
    try {
        const parsed = JSON.parse(fs.readFileSync(env.FCM_SERVICE_ACCOUNT_FILE, 'utf8'));
        if (parsed.project_id && parsed.client_email && parsed.private_key) {
            account = {
                project_id: String(parsed.project_id),
                client_email: String(parsed.client_email),
                private_key: String(parsed.private_key),
                token_uri: String(parsed.token_uri || 'https://oauth2.googleapis.com/token'),
            };
        }
    } catch {
        account = null;
    }
    return account;
}

/** Whether a usable service account is configured. */
export function pushConfigured(): boolean {
    return loadAccount() !== null;
}

/** Forgets the cached credentials (tests, or after replacing the file). */
export function resetPushCredentials() {
    account = undefined;
    accessToken = null;
}

const base64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

async function token(force = false): Promise<string> {
    const credentials = loadAccount();
    if (!credentials) throw new Error('FCM is not configured');
    if (!force && accessToken && accessToken.expiresAt > Date.now() + 60_000) return accessToken.value;
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(JSON.stringify({
        iss: credentials.client_email, scope: SCOPE, aud: credentials.token_uri, iat: now, exp: now + 3600,
    }))}`;
    const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), credentials.private_key).toString('base64url');
    const response = await fetch(credentials.token_uri, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: `${unsigned}.${signature}`,
        }),
        signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json().catch(() => ({})) as { access_token?: string; expires_in?: number };
    if (!response.ok || !body.access_token) throw new Error(`FCM token request failed (${response.status})`);
    accessToken = { value: body.access_token, expiresAt: Date.now() + Number(body.expires_in ?? 3600) * 1000 };
    return accessToken.value;
}

/** The FCM v1 request body for one phone. */
export function fcmPayload(registrationToken: string, message: PushMessage) {
    const alert = message.channel === 'alerts';
    return {
        message: {
            token: registrationToken,
            notification: { title: message.title, body: message.body },
            data: { ...message.data, route: message.route },
            android: {
                priority: alert ? 'HIGH' : 'NORMAL',
                ttl: alert ? '3600s' : '86400s',
                notification: {
                    channel_id: message.channel,
                    ...(message.tag ? { tag: message.tag } : {}),
                    default_sound: true,
                    notification_priority: alert ? 'PRIORITY_HIGH' : 'PRIORITY_DEFAULT',
                },
            },
            apns: {
                headers: { 'apns-priority': alert ? '10' : '5', ...(message.tag ? { 'apns-collapse-id': message.tag.slice(0, 64) } : {}) },
                payload: { aps: { sound: 'default' } },
            },
        },
    };
}

/** Tokens FCM says will never work again (app removed, token replaced, other project). */
function invalidToken(status: number, body: any): boolean {
    if (status === 404) return true;
    const details: any[] = Array.isArray(body?.error?.details) ? body.error.details : [];
    const code = details.map(item => item?.errorCode).find(Boolean);
    if (code === 'UNREGISTERED' || code === 'SENDER_ID_MISMATCH') return true;
    return status === 400 && code === 'INVALID_ARGUMENT' && /registration token/i.test(String(body?.error?.message ?? ''));
}

/** Sends to one phone; retries once on an expired OAuth token or a temporary FCM error. */
export async function sendToToken(registrationToken: string, message: PushMessage): Promise<SendResult> {
    const credentials = loadAccount();
    if (!credentials) return 'failed';
    const url = `${env.FCM_API_URL}/v1/projects/${encodeURIComponent(credentials.project_id)}/messages:send`;
    const payload = JSON.stringify(fcmPayload(registrationToken, message));
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { authorization: `Bearer ${await token(attempt > 0)}`, 'content-type': 'application/json' },
                body: payload,
                signal: AbortSignal.timeout(10_000),
            });
            if (response.ok) return 'sent';
            const body = await response.json().catch(() => ({}));
            if (invalidToken(response.status, body)) return 'invalid_token';
            if (response.status !== 401 && response.status !== 429 && response.status < 500) return 'failed';
        } catch {
            // network error: one more try
        }
        if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 500));
    }
    return 'failed';
}
