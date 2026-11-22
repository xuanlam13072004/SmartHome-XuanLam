import crypto from 'node:crypto';
import os from 'node:os';

/**
 * End-to-end probes for the load-test report (docs/architecture/load-testing.md).
 * Simulated users act like app users through the public API Gateway:
 * - `commands`: send a harmless command to one of their online devices and
 *   measure from the request until the device's result is recorded (the
 *   operation's `completed_at`), and inside the backend from `accepted_at`;
 * - `app_reads`: open the app's main lists (devices, badges, notifications)
 *   and measure each request.
 * Everything goes through the same API, MQTT and database as a real phone;
 * nothing here is a shortcut into the backend except reading the timestamps.
 */

export type ProbeKind = 'commands' | 'app_reads';

export interface ProbeParams {
    kind: ProbeKind;
    /** Simulated users taking part. */
    users: number;
    /** Commands (or rounds of reads) per user. */
    per_user: number;
    /** Users acting at the same time. */
    concurrency: number;
}

export interface ProbeSample {
    /** Milliseconds since the probe started. */
    at: number;
    /** What the user waited for (end to end). */
    ms: number;
    /** Inside the backend: accepted → completed (commands only). */
    server_ms?: number;
    ok: boolean;
    /** HTTP status, error code or operation status when not ok; the request for reads. */
    code?: string;
    what?: string;
}

export interface LatencyStats {
    count: number;
    mean_ms: number;
    p50_ms: number;
    p90_ms: number;
    p95_ms: number;
    p99_ms: number;
    max_ms: number;
}

export interface ProbeResult {
    id: string;
    params: ProbeParams;
    status: 'preparing' | 'running' | 'completed' | 'stopped' | 'failed';
    started_at: string;
    finished_at: string | null;
    /** What else the system was doing (devices online, telemetry rate) when it started. */
    context: Record<string, number>;
    machine: { cpus: number; cpu_model: string; memory_gb: number; platform: string };
    users_used: number;
    totals: { requests: number; ok: number; failed: number };
    latency: LatencyStats | null;
    server: LatencyStats | null;
    throughput_per_second: number;
    errors: Record<string, number>;
    note: string | null;
    samples: ProbeSample[];
}

export const PROBE_LIMITS = { users: 2000, per_user: 20, concurrency: 200, samples: 20000 } as const;

const percentile = (sorted: number[], fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];

export function latencyStats(values: number[]): LatencyStats | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const round = (value: number) => Math.round(value * 10) / 10;
    return {
        count: sorted.length,
        mean_ms: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
        p50_ms: round(percentile(sorted, 0.5)),
        p90_ms: round(percentile(sorted, 0.9)),
        p95_ms: round(percentile(sorted, 0.95)),
        p99_ms: round(percentile(sorted, 0.99)),
        max_ms: round(sorted[sorted.length - 1]),
    };
}

/** Totals, percentiles and throughput from the samples. */
export function summarize(samples: ProbeSample[], durationMs: number) {
    const ok = samples.filter(sample => sample.ok);
    const errors: Record<string, number> = {};
    for (const sample of samples) {
        if (!sample.ok) errors[sample.code ?? 'error'] = (errors[sample.code ?? 'error'] ?? 0) + 1;
    }
    const server = ok.map(sample => sample.server_ms).filter((value): value is number => value !== undefined);
    return {
        totals: { requests: samples.length, ok: ok.length, failed: samples.length - ok.length },
        latency: latencyStats(ok.map(sample => sample.ms)),
        server: latencyStats(server),
        throughput_per_second: durationMs > 0 ? Math.round((samples.length / (durationMs / 1000)) * 100) / 100 : 0,
        errors,
    };
}

export function machineInfo(): ProbeResult['machine'] {
    const cpus = os.cpus();
    return {
        cpus: cpus.length,
        cpu_model: cpus[0]?.model?.trim() ?? 'unknown',
        memory_gb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
        platform: `${os.platform()} ${os.release()}`,
    };
}

interface OperationLike {
    instance_id: string;
    risk?: string;
    confirmation?: string;
    idempotent?: boolean;
    input?: Record<string, { default?: unknown }>;
    ack_policy?: { completion_signal?: string };
}

export interface ProbeCommand {
    instance_id: string;
    operation_name: string;
    input: Record<string, unknown>;
}

/**
 * A command that is safe to repeat on a real home: normal risk, no confirmation
 * or password, idempotent, every input has a default. Commands answered at once
 * come first (one that waits for a motor to finish would measure the motor).
 */
export function pickProbeCommand(operations: Record<string, OperationLike>): ProbeCommand | null {
    const safe = Object.entries(operations).filter(([, operation]) => operation.risk === 'normal'
        && (operation.confirmation === undefined || operation.confirmation === 'none')
        && operation.idempotent !== false
        && Object.values(operation.input ?? {}).every(schema => schema.default !== undefined));
    const ranked = [...safe].sort(([, left], [, right]) =>
        Number(Boolean(left.ack_policy?.completion_signal)) - Number(Boolean(right.ack_policy?.completion_signal)));
    const chosen = ranked[0];
    if (!chosen) return null;
    const [key, operation] = chosen;
    const input = Object.fromEntries(Object.entries(operation.input ?? {}).map(([name, schema]) => [name, schema.default]));
    return { instance_id: operation.instance_id, operation_name: key.split('.').slice(1).join('.'), input };
}

/** Samples as CSV for a spreadsheet or the report. */
export function probeCsv(result: ProbeResult): string {
    const header = 'at_ms,latency_ms,server_ms,ok,code,request';
    const rows = result.samples.map(sample => [
        sample.at, sample.ms, sample.server_ms ?? '', sample.ok ? 1 : 0, sample.code ?? '', sample.what ?? '',
    ].join(','));
    return `${[header, ...rows].join('\n')}\n`;
}

// ── Running a probe ────────────────────────────────────────────────────────

export interface ProbeUser {
    account_id: string;
    /** Online devices of this user with a safe command (commands probe). */
    devices: Array<{ mac: string; command: ProbeCommand }>;
}

export interface ProbeDeps {
    /** Users that can take part (for `commands`, with at least one online device). */
    users(kind: ProbeKind, limit: number): Promise<ProbeUser[]>;
    /** A valid access token for the user (stored session, refreshed or signed in again). */
    accessToken(accountId: string): Promise<string>;
    /** One request to the API Gateway, timed by the caller; never retried. */
    request(path: string, init: { method: string; token: string; body?: unknown }): Promise<{ status: number; body: any }>;
    /** Results of finished operations among [ids], from the operation table. */
    finished(ids: string[]): Promise<Array<{ id: string; status: string; accepted_at: Date; completed_at: Date }>>;
    context(): Record<string, number>;
    now(): number;
    sleep(ms: number): Promise<void>;
}

const OPERATION_TIMEOUT_MS = 30_000;
const POLL_MS = 150;
const READS = ['/devices', '/me/badges', '/me/notifications?limit=20'];

export class ProbeRun {
    readonly result: ProbeResult;
    private stopped = false;
    private stoppedByUser = false;
    private workDone = false;
    private waiting = new Map<string, { started: number; resolve: (value: ProbeSample) => void }>();
    private started = 0;

    constructor(private readonly deps: ProbeDeps, params: ProbeParams, id = crypto.randomUUID()) {
        this.result = {
            id,
            params,
            status: 'preparing',
            started_at: new Date(deps.now()).toISOString(),
            finished_at: null,
            context: deps.context(),
            machine: machineInfo(),
            users_used: 0,
            totals: { requests: 0, ok: 0, failed: 0 },
            latency: null,
            server: null,
            throughput_per_second: 0,
            errors: {},
            note: null,
            samples: [],
        };
    }

    /** Recomputes the summary (also while running, for the live view). */
    refresh() {
        const end = this.result.finished_at ? Date.parse(this.result.finished_at) : this.deps.now();
        Object.assign(this.result, summarize(this.result.samples, this.started ? end - this.started : 0));
    }

    async run(): Promise<ProbeResult> {
        const { params } = this.result;
        try {
            const users = await this.deps.users(params.kind, params.users);
            if (users.length === 0) {
                this.result.note = params.kind === 'commands'
                    ? 'Không có người dùng ảo nào có thiết bị đang kết nối với lệnh an toàn để thử.'
                    : 'Chưa có người dùng ảo nào. Hãy tạo người dùng và thiết bị trước.';
                this.result.status = 'failed';
                return this.result;
            }
            if (users.length < params.users) {
                this.result.note = `Chỉ có ${users.length} người dùng phù hợp (yêu cầu ${params.users}).`;
            }
            this.result.users_used = users.length;
            // Sign everyone in first: the probe measures the app's work, not logins.
            const tokens = new Map<string, string>();
            await this.parallel(users, Math.min(params.concurrency, 20), async (user) => {
                try {
                    tokens.set(user.account_id, await this.deps.accessToken(user.account_id));
                } catch {
                    // counted below as users that could not take part
                }
            });
            const ready = users.filter(user => tokens.has(user.account_id));
            if (ready.length === 0) {
                this.result.status = 'failed';
                this.result.note = 'Không đăng nhập được người dùng ảo nào.';
                return this.result;
            }
            this.result.status = 'running';
            this.started = this.deps.now();
            const watcher = params.kind === 'commands' ? this.watch() : null;
            await this.parallel(ready, params.concurrency, user => (params.kind === 'commands'
                ? this.commands(user, tokens.get(user.account_id)!)
                : this.reads(tokens.get(user.account_id)!)));
            this.workDone = true;
            await watcher;
            this.result.status = this.stoppedByUser ? 'stopped' : 'completed';
        } catch (error) {
            this.result.status = 'failed';
            this.result.note = error instanceof Error ? error.message : String(error);
        } finally {
            this.result.finished_at = new Date(this.deps.now()).toISOString();
            this.refresh();
        }
        return this.result;
    }

    /** Stops taking new work (what is in flight still finishes). */
    cancel() {
        this.stoppedByUser = true;
        this.stopped = true;
    }

    private record(sample: ProbeSample) {
        if (this.result.samples.length < PROBE_LIMITS.samples) this.result.samples.push(sample);
    }

    private async parallel<T>(items: T[], width: number, work: (item: T) => Promise<void>) {
        const queue = [...items];
        const worker = async () => {
            for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
                if (this.stopped && this.result.status === 'running') return;
                await work(item);
            }
        };
        await Promise.all(Array.from({ length: Math.max(1, Math.min(width, items.length)) }, worker));
    }

    private async commands(user: ProbeUser, token: string) {
        for (let index = 0; index < this.result.params.per_user && !this.stopped; index += 1) {
            const device = user.devices[index % user.devices.length];
            const started = this.deps.now();
            const at = started - this.started;
            let response: { status: number; body: any };
            try {
                response = await this.deps.request(`/devices/${encodeURIComponent(device.mac)}/operations`, {
                    method: 'POST',
                    token,
                    body: { ...device.command, idempotency_key: crypto.randomUUID() },
                });
            } catch {
                this.record({ at, ms: this.deps.now() - started, ok: false, code: 'network' });
                continue;
            }
            const operationId = response.body?.operation?.id ?? response.body?.operation_id ?? response.body?.id;
            if (response.status >= 300 || typeof operationId !== 'string') {
                const code = response.body?.error?.code ?? `HTTP_${response.status}`;
                this.record({ at, ms: this.deps.now() - started, ok: false, code });
                continue;
            }
            const sample = await new Promise<ProbeSample>(resolve => this.waiting.set(operationId, { started, resolve }));
            this.record({ ...sample, at });
            // A short pause between one user's commands, like a person tapping.
            await this.deps.sleep(200);
        }
    }

    /** Resolves waiting commands from the operation table until the probe ends. */
    private async watch() {
        // Until every user is done and nothing is waiting (a stop still lets in-flight commands finish).
        while (!this.workDone || this.waiting.size > 0) {
            await this.deps.sleep(POLL_MS);
            const ids = [...this.waiting.keys()];
            if (ids.length === 0) continue;
            const finished = await this.deps.finished(ids).catch(() => []);
            for (const row of finished) {
                const waiter = this.waiting.get(row.id);
                if (!waiter) continue;
                this.waiting.delete(row.id);
                const completed = new Date(row.completed_at).getTime();
                waiter.resolve({
                    at: 0,
                    ms: Math.max(0, completed - waiter.started),
                    server_ms: Math.max(0, completed - new Date(row.accepted_at).getTime()),
                    ok: row.status === 'succeeded',
                    ...(row.status === 'succeeded' ? {} : { code: row.status }),
                });
            }
            const now = this.deps.now();
            for (const [id, waiter] of this.waiting) {
                if (now - waiter.started < OPERATION_TIMEOUT_MS) continue;
                this.waiting.delete(id);
                waiter.resolve({ at: 0, ms: now - waiter.started, ok: false, code: 'no_result_30s' });
            }
        }
    }

    private async reads(token: string) {
        for (let round = 0; round < this.result.params.per_user && !this.stopped; round += 1) {
            for (const path of READS) {
                const started = this.deps.now();
                try {
                    const response = await this.deps.request(path, { method: 'GET', token });
                    const ok = response.status < 300;
                    this.record({
                        at: started - this.started, ms: this.deps.now() - started, ok, what: path.split('?')[0],
                        ...(ok ? {} : { code: response.body?.error?.code ?? `HTTP_${response.status}` }),
                    });
                } catch {
                    this.record({ at: started - this.started, ms: this.deps.now() - started, ok: false, code: 'network', what: path });
                }
            }
            await this.deps.sleep(500);
        }
    }
}
