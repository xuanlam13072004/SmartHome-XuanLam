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
    /** Bumped on every reschedule; heap entries of older generations are stale. */
    generation: number;
}

interface HeapEntry {
    dueAt: number;
    task: ScheduledTask;
    generation: number;
}

export interface TelemetrySchedulerStats {
    registered: number;
    active: number;
    due: number;
}

/**
 * Central telemetry scheduler. Due times live in a binary min-heap, so each
 * publish costs O(log n) instead of a scan of every registered device: at
 * 30 000 devices the previous scan-and-sort saturated one CPU core at about
 * 130 messages per second.
 */
export class TelemetryScheduler {
    private readonly tasks = new Map<string, ScheduledTask>();
    private readonly heap: HeapEntry[] = [];
    private timer: NodeJS.Timeout | null = null;
    private timerDueAt = Number.POSITIVE_INFINITY;
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
        this.stopped = false;
        const existing = this.tasks.get(schedule.deviceId);
        if (existing) {
            existing.runId = schedule.runId;
            existing.intervalMs = schedule.intervalMs;
            existing.jitterPercent = schedule.jitterPercent;
            existing.initialDelayMs = schedule.initialDelayMs;
            existing.publish = schedule.publish;
            if (!existing.running) {
                this.enqueue(existing, Date.now() + Math.max(0, schedule.initialDelayMs));
            }
            this.drain();
            return;
        }
        const task: ScheduledTask = {
            ...schedule,
            dueAt: 0,
            running: false,
            generation: 0,
        };
        this.tasks.set(schedule.deviceId, task);
        this.enqueue(task, Date.now() + Math.max(0, schedule.initialDelayMs));
        this.drain();
    }

    unregister(deviceId: string): void {
        const task = this.tasks.get(deviceId);
        if (!task) return;
        this.tasks.delete(deviceId);
        task.generation += 1;
        this.compactIfSparse();
    }

    getStats(runId?: string): TelemetrySchedulerStats {
        const now = Date.now();
        let registered = 0;
        let active = 0;
        let due = 0;
        for (const task of this.tasks.values()) {
            if (runId && task.runId !== runId) continue;
            registered += 1;
            if (task.running) active += 1;
            else if (task.dueAt <= now) due += 1;
        }
        return { registered, active, due };
    }

    stop(): void {
        this.stopped = true;
        this.tasks.clear();
        this.heap.length = 0;
        this.clearTimer();
    }

    private enqueue(task: ScheduledTask, dueAt: number): void {
        task.generation += 1;
        task.dueAt = dueAt;
        this.push({ dueAt, task, generation: task.generation });
    }

    private isLive(entry: HeapEntry): boolean {
        return !entry.task.running
            && entry.generation === entry.task.generation
            && this.tasks.get(entry.task.deviceId) === entry.task;
    }

    private drain(): void {
        if (this.stopped) return;
        const now = Date.now();
        while (this.active < this.maxConcurrency && this.heap.length > 0) {
            const top = this.heap[0];
            if (!this.isLive(top)) {
                this.pop();
                continue;
            }
            if (top.dueAt > now) break;
            this.pop();
            this.execute(top.task);
        }
        this.armTimer();
    }

    private armTimer(): void {
        while (this.heap.length > 0 && !this.isLive(this.heap[0])) this.pop();
        if (this.stopped || this.active >= this.maxConcurrency || this.heap.length === 0) {
            this.clearTimer();
            return;
        }
        const dueAt = this.heap[0].dueAt;
        if (this.timer && this.timerDueAt <= dueAt) return;
        this.clearTimer();
        this.timerDueAt = dueAt;
        this.timer = setTimeout(() => {
            this.timer = null;
            this.timerDueAt = Number.POSITIVE_INFINITY;
            this.drain();
        }, Math.max(0, dueAt - Date.now()));
        this.timer.unref();
    }

    private clearTimer(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.timerDueAt = Number.POSITIVE_INFINITY;
    }

    private execute(task: ScheduledTask): void {
        task.running = true;
        this.active += 1;

        void task.publish()
            .catch((error) => this.onTaskError(task.deviceId, error))
            .finally(() => {
                this.active -= 1;
                task.running = false;
                if (this.tasks.get(task.deviceId) === task) {
                    this.enqueue(task, Date.now() + nextTelemetryDelayMs(
                        task.intervalMs,
                        task.jitterPercent,
                    ));
                }
                this.drain();
            });
    }

    /** Unregistered devices leave stale heap entries; rebuild when they dominate. */
    private compactIfSparse(): void {
        if (this.heap.length < 1024 || this.heap.length < this.tasks.size * 2) return;
        const live = this.heap.filter((entry) => this.isLive(entry));
        this.heap.length = 0;
        for (const entry of live) this.push(entry);
    }

    private push(entry: HeapEntry): void {
        const heap = this.heap;
        heap.push(entry);
        let index = heap.length - 1;
        while (index > 0) {
            const parent = (index - 1) >> 1;
            if (heap[parent].dueAt <= entry.dueAt) break;
            heap[index] = heap[parent];
            index = parent;
        }
        heap[index] = entry;
    }

    private pop(): HeapEntry | undefined {
        const heap = this.heap;
        const top = heap[0];
        const last = heap.pop();
        if (heap.length > 0 && last) {
            let index = 0;
            const length = heap.length;
            for (;;) {
                const left = index * 2 + 1;
                if (left >= length) break;
                const right = left + 1;
                const child = right < length && heap[right].dueAt < heap[left].dueAt ? right : left;
                if (heap[child].dueAt >= last.dueAt) break;
                heap[index] = heap[child];
                index = child;
            }
            heap[index] = last;
        }
        return top;
    }
}

let schedulerInstance: TelemetryScheduler | null = null;

export const getTelemetryScheduler = (): TelemetryScheduler => {
    if (!schedulerInstance) {
        schedulerInstance = new TelemetryScheduler(env.TELEMETRY_PUBLISH_CONCURRENCY);
    }
    return schedulerInstance;
};
