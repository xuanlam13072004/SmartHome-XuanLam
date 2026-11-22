import type { FastifyInstance } from 'fastify';
import { runDueAutomations } from '../modules/automations/firing';
import { purgeOldAssistantTurns } from '../modules/assistant/service';
import { purgeOldAccountNotifications } from '../modules/notifications/accountNotifications';
import { purgeOldPlanReminders, sendPlanReminders } from '../modules/payments/reminders';
import { purgeStalePushTokens } from '../modules/push/service';
import { purgeOldRuns, reconcileRuns, runDueSteps } from '../modules/scenes/runs';
import { runDueSchedules } from '../modules/scenes/schedules';

const TICK_MS = 1000;
const PURGE_EVERY_MS = 10 * 60 * 1000;
const REMINDERS_EVERY_MS = 5 * 60 * 1000;

/**
 * Fires due schedules and time-triggered automations, then moves scene runs
 * forward: sends steps whose delay is over, copies finished device operations
 * into their steps, closes finished runs, and trims old history and
 * notifications. Every few minutes it also sends plan expiry reminders. Several Gateway instances can run it at once (claims use
 * FOR UPDATE SKIP LOCKED; every update is conditional).
 */
export class SceneRunner {
    private timer: NodeJS.Timeout | null = null;
    private busy = false;
    private lastPurge = 0;
    private lastReminders = 0;

    constructor(private readonly app: FastifyInstance) {}

    start() {
        this.timer = setInterval(() => void this.tick(), TICK_MS);
        this.timer.unref();
    }

    async stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        while (this.busy) await new Promise(resolve => setTimeout(resolve, 50));
    }

    private async tick() {
        if (this.busy) return;
        this.busy = true;
        try {
            // Drain bursts (many schedules due at the same minute) without waiting a tick per batch.
            while (await runDueSchedules(this.app) === 50) { /* next batch */ }
            while (await runDueAutomations(this.app) === 50) { /* next batch */ }
            while (await runDueSteps(this.app) === 50) { /* next batch */ }
            await reconcileRuns(this.app);
            if (Date.now() - this.lastReminders > REMINDERS_EVERY_MS) {
                this.lastReminders = Date.now();
                await sendPlanReminders({ pg: this.app.pg, redis: this.app.redis, log: this.app.log });
            }
            if (Date.now() - this.lastPurge > PURGE_EVERY_MS) {
                this.lastPurge = Date.now();
                await purgeOldRuns(this.app);
                await purgeOldAccountNotifications(this.app);
                await purgeOldAssistantTurns(this.app);
                await purgeStalePushTokens(this.app.pg);
                await purgeOldPlanReminders(this.app.pg);
            }
        } catch (error) {
            this.app.log.error({ error }, 'Scene runner tick failed');
        } finally {
            this.busy = false;
        }
    }
}
