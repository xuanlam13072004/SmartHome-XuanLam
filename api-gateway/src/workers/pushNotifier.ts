import type { FastifyInstance } from 'fastify';
import type Redis from 'ioredis';
import { REDIS_CHANNELS } from '../../../shared/constants';
import { env } from '../config/env';
import { pushConfigured } from '../modules/push/fcm';
import {
    accountPushFrom,
    deviceAlertFrom,
    deviceAlertTokens,
    messageKey,
    pushToAccounts,
    sendToTokens,
} from '../modules/push/service';

/**
 * Turns what the apps already receive live into push notifications for
 * phones where the app is closed: warning/critical device events
 * (`device.event`) and personal events (`account.event`: automation and
 * security notices, payments, sharing, plan reminders). Every Gateway
 * instance receives every publication; a Redis key per message lets exactly
 * one of them send. The same alert of the same device is pushed at most once
 * per PUSH_EVENT_THROTTLE_SECONDS. Off without a Firebase service account.
 */

const SEEN_SECONDS = 600;
const MAX_IN_FLIGHT = 500;
const ALERT_SEVERITY = /"severity":"(warning|critical)"/;

export class PushNotifier {
    private subscriber: Redis | null = null;
    private inFlight = new Set<Promise<void>>();
    private dropped = 0;

    constructor(private readonly app: FastifyInstance) {}

    async start() {
        if (!pushConfigured()) {
            this.app.log.info('Push notifications are off (no FCM_SERVICE_ACCOUNT_FILE)');
            return;
        }
        this.subscriber = this.app.redis.duplicate();
        this.subscriber.on('message', (channel: string, raw: string) => this.track(this.handle(channel, raw)));
        await this.subscriber.subscribe(REDIS_CHANNELS.DEVICE_EVENT, REDIS_CHANNELS.ACCOUNT_EVENT);
        this.app.log.info('Push notifications are on');
    }

    async stop() {
        await this.subscriber?.quit().catch(() => undefined);
        this.subscriber = null;
        await this.idle();
    }

    async idle() {
        while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
    }

    private track(work: Promise<void>) {
        if (this.inFlight.size >= MAX_IN_FLIGHT) {
            // A flood (load test, broken device): drop rather than grow without bound.
            this.dropped += 1;
            if (this.dropped % 100 === 1) this.app.log.warn({ dropped: this.dropped }, 'Push notifier is saturated');
            return;
        }
        this.inFlight.add(work);
        void work.finally(() => this.inFlight.delete(work));
    }

    /** One Redis publication (public for tests). */
    async handle(channel: string, raw: string): Promise<void> {
        try {
            if (channel === REDIS_CHANNELS.DEVICE_EVENT) {
                // Most events are informational: skip them before parsing.
                if (!ALERT_SEVERITY.test(raw)) return;
                const alert = deviceAlertFrom(JSON.parse(raw));
                if (!alert || !(await this.firstToSee(channel, raw))) return;
                if (env.PUSH_EVENT_THROTTLE_SECONDS > 0) {
                    const fresh = await this.app.redis.set(
                        `push:throttle:${alert.mac}:${alert.eventName}`, '1', 'EX', env.PUSH_EVENT_THROTTLE_SECONDS, 'NX',
                    );
                    if (!fresh) return;
                }
                const recipients = await deviceAlertTokens(this.app.pg, alert.mac, alert.category);
                if (recipients.length === 0) return;
                await sendToTokens(this.deps, recipients.map(row => row.token), {
                    ...alert.message, body: recipients[0].device_name,
                });
            } else if (channel === REDIS_CHANNELS.ACCOUNT_EVENT) {
                const push = accountPushFrom(JSON.parse(raw));
                if (!push || !(await this.firstToSee(channel, raw))) return;
                await pushToAccounts(this.deps, [push.accountId], push.message);
            }
        } catch (error) {
            this.app.log.warn({ error, channel }, 'Push notification failed');
        }
    }

    private get deps() {
        return { pg: this.app.pg, log: this.app.log };
    }

    private async firstToSee(channel: string, raw: string): Promise<boolean> {
        return Boolean(await this.app.redis.set(`push:seen:${messageKey(channel, raw)}`, '1', 'EX', SEEN_SECONDS, 'NX'));
    }
}
