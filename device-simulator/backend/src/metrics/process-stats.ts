import { monitorEventLoopDelay } from 'node:perf_hooks';

export interface ProcessStats {
    cpu_percent: number;
    rss_bytes: number;
    heap_used_bytes: number;
    event_loop_delay_p99_ms: number;
    uptime_seconds: number;
}

/**
 * CPU and event-loop health of the simulator process. A load test is only
 * meaningful while the simulator itself keeps up: high CPU or event-loop
 * delay means the simulator, not the backend, is the bottleneck.
 */
class ProcessSampler {
    private readonly loop = monitorEventLoopDelay({ resolution: 20 });
    private lastCpu = process.cpuUsage();
    private lastAt = process.hrtime.bigint();
    private cpuPercent = 0;
    private delayP99Ms = 0;
    private timer: NodeJS.Timeout | null = null;

    start(): void {
        if (this.timer) return;
        this.loop.enable();
        this.timer = setInterval(() => this.sample(), 2000);
        this.timer.unref();
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.loop.disable();
    }

    stats(): ProcessStats {
        const memory = process.memoryUsage();
        return {
            cpu_percent: this.cpuPercent,
            rss_bytes: memory.rss,
            heap_used_bytes: memory.heapUsed,
            event_loop_delay_p99_ms: this.delayP99Ms,
            uptime_seconds: Math.round(process.uptime()),
        };
    }

    private sample(): void {
        const now = process.hrtime.bigint();
        const cpu = process.cpuUsage(this.lastCpu);
        const elapsedMicros = Number(now - this.lastAt) / 1000;
        this.cpuPercent = elapsedMicros > 0
            ? Math.round(((cpu.user + cpu.system) / elapsedMicros) * 1000) / 10
            : 0;
        this.delayP99Ms = Math.round(this.loop.percentile(99) / 1e5) / 10;
        this.loop.reset();
        this.lastCpu = process.cpuUsage();
        this.lastAt = now;
    }
}

export const processSampler = new ProcessSampler();
