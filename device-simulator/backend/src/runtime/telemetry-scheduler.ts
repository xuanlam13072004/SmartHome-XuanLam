import { env } from '../config/env';
import { nextTelemetryDelayMs } from './scheduling';

export interface TelemetrySchedule {
    deviceId: string;
    runId: string;
    intervalMs: number;
    jitterPercent: number;
    initialDelayMs: number;
    publish: () => Promise<void>;
}

interface ScheduledTask extends TelemetrySchedule {
    dueAt: number;
    running: boolean;
}

export interface TelemetrySchedulerStats {
    registered: number;
    active: number;
    due: number;
}

export class TelemetryScheduler {
    private readonly tasks = new Map<string, ScheduledTask>();
    private timer: NodeJS.Timeout | null = null;
    private active = 0;
    private stopped = false;

    constructor(
        private readonly maxConcurrency: number,
        private readonly onTaskError: (deviceId: string, error: unknown) => void = () => undefined,
    ) {
        if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
            throw new Error('Telemetry scheduler concurrency must be a positive integer');
        }
    }

    register(schedule: TelemetrySchedule): void {
        const existing = this.tasks.get(schedule.deviceId);
        if (existing) {
            existing.runId = schedule.runId;
            existing.intervalMs = schedule.intervalMs;
            existing.jitterPercent = schedule.jitterPercent;
            existing.initialDelayMs = schedule.initialDelayMs;
            existing.publish = schedule.publish;
            if (!existing.running) {
                existing.dueAt = Date.now() + Math.max(0, schedule.initialDelayMs);
            }
            this.stopped = false;
            this.scheduleNextDrain();
            return;
        }
        const task: ScheduledTask = {
            ...schedule,
            dueAt: Date.now() + Math.max(0, schedule.initialDelayMs),
            running: false,
        };
        this.tasks.set(schedule.deviceId, task);
        this.stopped = false;
        this.scheduleNextDrain();
    }

    unregister(deviceId: string): void {
        this.tasks.delete(deviceId);
        this.scheduleNextDrain();
    }

    getStats(runId?: string): TelemetrySchedulerStats {
        const now = Date.now();
        const tasks = [...this.tasks.values()].filter(
            (task) => !runId || task.runId === runId,
        );
        return {
            registered: tasks.length,
            active: tasks.filter((task) => task.running).length,
            due: tasks.filter((task) => !task.running && task.dueAt <= now).length,
        };
    }

    stop(): void {
        this.stopped = true;
        this.tasks.clear();
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    private scheduleNextDrain(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.stopped || this.active >= this.maxConcurrency) return;

        let nextDueAt = Number.POSITIVE_INFINITY;
        for (const task of this.tasks.values()) {
            if (!task.running && task.dueAt < nextDueAt) nextDueAt = task.dueAt;
        }
        if (!Number.isFinite(nextDueAt)) return;

        const delayMs = Math.max(0, nextDueAt - Date.now());
        this.timer = setTimeout(() => {
            this.timer = null;
            this.drain();
        }, delayMs);
        this.timer.unref();
    }

    private drain(): void {
        if (this.stopped) return;
        const availableSlots = this.maxConcurrency - this.active;
        if (availableSlots <= 0) return;

        const now = Date.now();
        const dueTasks = [...this.tasks.values()]
            .filter((task) => !task.running && task.dueAt <= now)
            .sort((left, right) => left.dueAt - right.dueAt)
            .slice(0, availableSlots);

        for (const task of dueTasks) this.execute(task);
        this.scheduleNextDrain();
    }

    private execute(task: ScheduledTask): void {
        task.running = true;
        this.active += 1;

        void task.publish()
            .catch((error) => this.onTaskError(task.deviceId, error))
            .finally(() => {
                this.active -= 1;
                const current = this.tasks.get(task.deviceId);
                if (current === task) {
                    task.running = false;
                    task.dueAt = Date.now() + nextTelemetryDelayMs(
                        task.intervalMs,
                        task.jitterPercent,
                    );
                }
                this.drain();
            });
    }
}

let schedulerInstance: TelemetryScheduler | null = null;

export const getTelemetryScheduler = (): TelemetryScheduler => {
    if (!schedulerInstance) {
        schedulerInstance = new TelemetryScheduler(env.TELEMETRY_PUBLISH_CONCURRENCY);
    }
    return schedulerInstance;
};
