import crypto from 'node:crypto';
import type { Pool } from 'pg';
import { NOTIFICATION_SEVERITIES, notificationCategory } from '../../../../shared/notification-categories';
import { pushSent } from '../../metrics/registry';
import { type PushMessage, pushConfigured, sendToToken } from './fcm';
import { eventTitle, vietnamDate, vnd } from './labels';

/**
 * Who gets which push. Phones are registered per session (`push_tokens`);
 * only phones of active sessions receive. Device alerts go to every active
 * member of the device who has not muted its category (safety cannot be
 * muted), like the notification center. Account events (automation and
 * security notices, payments, sharing, plan reminders) go to that account.
 */

export interface PushDeps {
    pg: Pool;
    log: { warn: (obj: object, msg: string) => void };
}

const MAX_TOKENS_PER_ACCOUNT = 10;
const SEND_CONCURRENCY = 8;

export async function registerPushToken(
    pg: Pool,
    input: { accountId: string; sessionId: string; token: string; platform: 'android' | 'ios' },
) {
    // A phone signed in to another account moves to the new one.
    await pg.query(
        `INSERT INTO push_tokens (token, account_id, session_id, platform) VALUES ($1, $2, $3, $4)
         ON CONFLICT (token) DO UPDATE SET account_id = EXCLUDED.account_id, session_id = EXCLUDED.session_id,
             platform = EXCLUDED.platform, updated_at = NOW()`,
        [input.token, input.accountId, input.sessionId, input.platform],
    );
    await pg.query(
        `DELETE FROM push_tokens WHERE token IN (
             SELECT token FROM push_tokens WHERE account_id = $1 ORDER BY updated_at DESC OFFSET $2)`,
        [input.accountId, MAX_TOKENS_PER_ACCOUNT],
    );
}

export async function removePushToken(pg: Pool, accountId: string, token: string) {
    await pg.query('DELETE FROM push_tokens WHERE token = $1 AND account_id = $2', [token, accountId]);
}

/** Phones of signed-out or expired sessions (they no longer receive anyway). */
export async function purgeStalePushTokens(pg: Pool): Promise<number> {
    const result = await pg.query(
        `DELETE FROM push_tokens WHERE token IN (
             SELECT token.token FROM push_tokens AS token
             JOIN user_sessions AS session ON session.id = token.session_id
             WHERE session.status <> 'active' OR session.expires_at < NOW()
             LIMIT 5000)`,
    );
    return result.rowCount ?? 0;
}

const ACTIVE_SESSION = `JOIN user_sessions AS session
    ON session.id = token.session_id AND session.status = 'active' AND session.expires_at > NOW()`;

async function accountTokens(pg: Pool, accountIds: string[]): Promise<string[]> {
    if (accountIds.length === 0) return [];
    const result = await pg.query(
        `SELECT token.token FROM push_tokens AS token ${ACTIVE_SESSION} WHERE token.account_id = ANY($1::uuid[])`,
        [accountIds],
    );
    return result.rows.map(row => row.token as string);
}

/** Phones that get an alert of [mac] in [category], with the device's name. */
export async function deviceAlertTokens(pg: Pool, mac: string, category: string) {
    const result = await pg.query(
        `SELECT token.token, device.name AS device_name
         FROM device_metadata AS device
         JOIN device_memberships AS membership
           ON membership.device_id = device.id AND membership.status = 'active'
          AND (membership.expires_at IS NULL OR membership.expires_at > NOW())
         JOIN push_tokens AS token ON token.account_id = membership.account_id
         ${ACTIVE_SESSION}
         LEFT JOIN account_preferences AS preferences ON preferences.account_id = membership.account_id
         WHERE device.mac = $1 AND device.is_active
           AND ($2 = 'safety' OR NOT (COALESCE(preferences.muted_notification_categories, ARRAY[]::text[]) @> ARRAY[$2::text]))`,
        [mac, category],
    );
    return result.rows as Array<{ token: string; device_name: string }>;
}

export interface SendStats { sent: number; invalid: number; failed: number }

/** Sends one message to these phones; tokens FCM rejects for good are deleted. */
export async function sendToTokens(deps: PushDeps, tokens: string[], message: PushMessage): Promise<SendStats> {
    const stats: SendStats = { sent: 0, invalid: 0, failed: 0 };
    if (tokens.length === 0 || !pushConfigured()) return stats;
    const invalid: string[] = [];
    const queue = [...new Set(tokens)];
    const worker = async () => {
        for (let token = queue.shift(); token !== undefined; token = queue.shift()) {
            const result = await sendToToken(token, message);
            pushSent.inc({ result });
            if (result === 'sent') stats.sent += 1;
            else if (result === 'invalid_token') invalid.push(token);
            else stats.failed += 1;
        }
    };
    await Promise.all(Array.from({ length: Math.min(SEND_CONCURRENCY, queue.length) }, worker));
    stats.invalid = invalid.length;
    if (invalid.length > 0) {
        await deps.pg.query('DELETE FROM push_tokens WHERE token = ANY($1::text[])', [invalid])
            .catch(error => deps.log.warn({ error }, 'Failed to delete invalid push tokens'));
    }
    if (stats.failed > 0) deps.log.warn({ failed: stats.failed, title: message.title }, 'Some push notifications failed');
    return stats;
}

export async function pushToAccounts(deps: PushDeps, accountIds: string[], message: PushMessage): Promise<SendStats> {
    return sendToTokens(deps, await accountTokens(deps.pg, accountIds), message);
}

// ── What a Redis message becomes ───────────────────────────────────────────

export interface DeviceAlert {
    mac: string;
    eventName: string;
    category: string;
    /** Everything but the device name, added per recipient query. */
    message: Omit<PushMessage, 'body'>;
}

/** A warning/critical device event from `device.event`; null for anything else. */
export function deviceAlertFrom(parsed: any): DeviceAlert | null {
    const payload = parsed?.payload;
    const mac = typeof parsed?.mac === 'string' ? parsed.mac : null;
    if (!mac || !payload || !(NOTIFICATION_SEVERITIES as readonly string[]).includes(payload.severity)) return null;
    const eventName = String(payload.event_name ?? '');
    if (!eventName) return null;
    const category = typeof payload.category === 'string' ? payload.category : notificationCategory(String(payload.capability_id ?? ''));
    const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
    const loud = payload.severity === 'critical' || category === 'safety' || category === 'security';
    return {
        mac,
        eventName,
        category,
        message: {
            title: eventTitle(eventName, data),
            route: `/device/${mac}`,
            channel: loud ? 'alerts' : 'general',
            tag: `${mac}:${eventName}`,
            data: { kind: 'device_event', mac, event: eventName },
        },
    };
}

const text = (value: unknown, max = 120) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** A personal event from `account.event` worth a push; null for the rest (scene progress…). */
export function accountPushFrom(parsed: any): { accountId: string; message: PushMessage } | null {
    const accountId = typeof parsed?.account_id === 'string' ? parsed.account_id : null;
    const data = parsed?.data && typeof parsed.data === 'object' ? parsed.data : {};
    if (!accountId) return null;
    const message = ((): PushMessage | null => {
        switch (parsed.event) {
            case 'notification_created': {
                const item = data.notification ?? {};
                if (item.kind === 'security') {
                    return {
                        title: 'Cảnh báo bảo mật', body: text(item.body) || 'Có cảnh báo bảo mật mới',
                        route: '/profile/voice', channel: 'alerts',
                    };
                }
                return {
                    title: text(item.title, 60) || 'Tự động hóa', body: text(item.body, 160) || 'Tự động hóa vừa gửi thông báo',
                    route: '/profile/notifications', channel: 'general',
                };
            }
            case 'payment_updated': {
                const order = data.order ?? {};
                const tag = `order:${text(order.code, 20)}`;
                if (order.status === 'paid') {
                    const until = order.plan_expires_at ? ` đến ${vietnamDate(order.plan_expires_at)}` : '';
                    return {
                        title: 'Thanh toán thành công', body: `Gói ${text(order.plan?.name, 40)} đã được kích hoạt${until}.`,
                        route: '/profile/plans', channel: 'general', tag,
                    };
                }
                if (order.status === 'review') {
                    const missing = Number(order.amount_vnd) - Number(order.received_vnd);
                    return {
                        title: 'Đã nhận một phần thanh toán',
                        body: `Đơn ${text(order.code, 20)} còn thiếu ${vnd(missing)}. Bạn chuyển nốt với cùng nội dung nhé.`,
                        route: '/profile/plans', channel: 'general', tag,
                    };
                }
                return null;
            }
            case 'sharing_invite_received':
                return {
                    title: 'Lời mời dùng chung thiết bị',
                    body: `${text(data.owner_name, 60) || 'Ai đó'} mời bạn dùng chung "${text(data.device_name, 60)}".`,
                    route: '/profile/sharing', channel: 'general',
                };
            case 'sharing_member_joined':
                return {
                    title: 'Lời mời đã được chấp nhận',
                    body: `${text(data.member_name, 60) || 'Một người'} đã chấp nhận lời mời dùng "${text(data.device_name, 60)}".`,
                    route: '/profile/sharing', channel: 'general',
                };
            case 'plan_expiring':
                return {
                    title: 'Gói trợ lý sắp hết hạn',
                    body: `Gói ${text(data.plan?.name, 40)} hết hạn ngày ${vietnamDate(data.expires_at)}. Gia hạn để dùng tiếp không gián đoạn.`,
                    route: `/assistant?renew=${encodeURIComponent(text(data.plan?.code, 20))}`, channel: 'general',
                    tag: `plan:${text(data.plan?.code, 20)}`,
                };
            case 'plan_expired':
                return {
                    title: 'Gói trợ lý đã hết hạn',
                    body: `Gói ${text(data.plan?.name, 40)} đã hết hạn, tài khoản về gói Miễn phí. Bạn có thể gia hạn bất cứ lúc nào.`,
                    route: `/assistant?renew=${encodeURIComponent(text(data.plan?.code, 20))}`, channel: 'general',
                    tag: `plan:${text(data.plan?.code, 20)}`,
                };
            default:
                return null;
        }
    })();
    return message ? { accountId, message: { ...message, data: { kind: String(parsed.event) } } } : null;
}

/** Same message on the same channel (each Gateway instance receives every publication). */
export function messageKey(channel: string, raw: string): string {
    return crypto.createHash('sha1').update(channel).update('\n').update(raw).digest('hex');
}
