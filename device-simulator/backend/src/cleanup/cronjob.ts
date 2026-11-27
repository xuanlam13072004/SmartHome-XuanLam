import type { FastifyBaseLogger } from 'fastify';
import { env } from '../config/env';
import type { CleanupProgress, SimulationRun } from '../domain/simulation-run';
import type {
    SimulatedDeviceRecord,
    SimulatedUserRecord,
} from '../domain/registry';
import { getMongoDb } from '../infrastructure/mongodb/client';
import { apiGateway, type ApiGatewayError } from '../infrastructure/api-gateway/client';
import { getRuntimeManager } from '../runtime/manager';
import { getGenerationQueue } from '../generation/queue';
import { recordSimulatorEvent } from '../events/service';
import { userAccessToken, userPassword } from '../security/user-session';
import { getMediaStore } from '../media';

/**
 * Removes what a run created, user by user, through the system's official
 * doors only (docs/architecture/load-testing.md):
 *   1. the user's virtual devices are switched off;
 *   2. signed in as the user, the devices it owns are unpaired (the app's
 *      "Gỡ thiết bị") and the account is deleted (the app's "Xóa tài khoản");
 *   3. the devices are retired with the factory API: their factory record,
 *      MQTT login and the data the system kept about them;
 *   4. the Simulator forgets the records and the virtual SD cards.
 * A run cleanup runs in the background with CLEANUP_CONCURRENCY users at a
 * time and writes its progress on the run. A user that cannot be cleaned
 * without a person (it owns a device someone added with the app, or one of
 * its devices is owned by another account) is skipped and reported as
 * blocked; a user that failed on an error (network, server) is tried three
 * times, then reported as failed. The others go on either way. Every step can
 * be repeated, so pressing "Dọn dữ liệu" again, or a restart, resumes the
 * cleanup with what is left.
 */

export interface BlockedUser {
    account_id?: string;
    email: string;
    reason: string;
}

export interface CleanupResult {
    status: 'cleaning' | 'cleaned' | 'cleanup_blocked' | 'cleanup_failed';
    accountsDeleted?: number;
    devicesDeleted?: number;
    retainedUsers?: number;
    blocked?: BlockedUser[];
    progress?: CleanupProgress;
}

type UserOutcome =
    | { state: 'cleaned'; accountDeleted: boolean; devices: number }
    | { state: 'blocked'; reason: string }
    | { state: 'failed'; reason: string };

type Gateway = Pick<typeof apiGateway, 'listDevices' | 'unpairDevice' | 'deleteAccount' | 'retireFactoryDevices'>;

const cleanupDependencies = {
    registryDb: getMongoDb,
    runtimeManager: getRuntimeManager as (logger: FastifyBaseLogger) => Pick<ReturnType<typeof getRuntimeManager>, 'removeDevice'>,
    generationQueue: getGenerationQueue as (logger: FastifyBaseLogger) => Pick<ReturnType<typeof getGenerationQueue>, 'stopRun'>,
    gateway: apiGateway as Gateway,
    accessToken: userAccessToken,
    event: recordSimulatorEvent,
    mediaStore: getMediaStore as (() => Pick<ReturnType<typeof getMediaStore>, 'wipeCamera' | 'removeEmptyRunDir'>) | undefined,
    concurrency: () => env.CLEANUP_CONCURRENCY,
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

const RETIRE_BATCH = 200;
const USER_ATTEMPTS = 3;
const PROGRESS_FLUSH_MS = 2000;
const MAX_BLOCKED_KEPT = 50;

const statusOf = (error: unknown): number => Number((error as ApiGatewayError | null)?.statusCode || 0);
const codeOf = (error: unknown): string | undefined => (error as ApiGatewayError | null)?.code;

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

export class CleanupCronjob {
    private readonly logger: FastifyBaseLogger;
    private timer: NodeJS.Timeout | null = null;
    private cleanupRunning = false;
    private cleanupTask: Promise<void> | null = null;
    private stopping = false;
    private readonly pendingRuns = new Map<string, Promise<CleanupResult>>();

    constructor(logger: FastifyBaseLogger, private readonly dependencies = cleanupDependencies) {
        this.logger = logger.child({ module: 'CleanupCronjob' });
    }

    start(): void {
        if (this.timer) return;
        this.stopping = false;
        this.logger.info({ intervalMs: env.CLEANUP_INTERVAL_MS }, 'Auto-cleanup scheduler started');
        void this.runCleanup();
        this.timer = setInterval(() => void this.runCleanup(), env.CLEANUP_INTERVAL_MS);
    }

    /** Stops between users: a run being cleaned stays 'cleaning' and resumes at the next start. */
    async stop(): Promise<void> {
        this.stopping = true;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        await this.cleanupTask;
        await Promise.allSettled([...this.pendingRuns.values()]);
    }

    /**
     * "Dọn dữ liệu" from the Console: starts the cleanup in the background and
     * answers at once; the Console follows `cleanup_progress` on the run.
     */
    async startRunCleanup(runId: string): Promise<CleanupResult> {
        const run = await this.runs().findOne({ id: runId }, { projection: { status: 1, cleanup_progress: 1 } });
        if (!run) throw httpError(404, 'Simulation run not found');
        if (run.status === 'cleaned') return { status: 'cleaned' };
        if (!this.pendingRuns.has(runId)) {
            void this.cleanupRun(runId).catch((error) => this.logger.error({ err: error, runId }, 'Run cleanup failed'));
        }
        return { status: 'cleaning', progress: run.cleanup_progress };
    }

    /**
     * Cleans a run and resolves when it is done. Without [expectedStatus]
     * someone asked for it ("Dọn dữ liệu"), so everything the run created goes,
     * kept users included: "Giữ dữ liệu" only stops the automatic cleanup. The
     * scheduled sweep passes the status it saw and leaves kept users alone.
     */
    async cleanupRun(runId: string, expectedStatus?: SimulationRun['status']): Promise<CleanupResult> {
        const pending = this.pendingRuns.get(runId);
        if (pending) return pending;
        const task = this.executeCleanupRun(runId, expectedStatus).finally(() => {
            if (this.pendingRuns.get(runId) === task) this.pendingRuns.delete(runId);
        });
        this.pendingRuns.set(runId, task);
        return task;
    }

    private runs() {
        return this.dependencies.registryDb().collection<SimulationRun>('simulation_runs');
    }

    private async executeCleanupRun(runId: string, expectedStatus?: SimulationRun['status']): Promise<CleanupResult> {
        const registryDb = this.dependencies.registryDb();
        const run = await this.runs().findOne({ id: runId });
        if (!run) throw httpError(404, 'Simulation run not found');
        if (run.status === 'cleaned') return { status: 'cleaned' };
        if (expectedStatus && run.status !== expectedStatus) throw httpError(409, 'Run changed before scheduled cleanup');

        // An interrupted cleanup resumes with the scope it started with.
        const includeKept = expectedStatus === 'cleaning' ? run.cleanup_includes_kept === true : !expectedStatus;
        const claimed = await this.runs().updateOne(
            { id: runId, ...(expectedStatus ? { status: expectedStatus } : {}) },
            { $set: { status: 'cleaning', cleanup_includes_kept: includeKept, updated_at: new Date() } },
        );
        if (claimed?.matchedCount === 0) throw httpError(409, 'Run changed before cleanup could start');
        // Take the snapshot only after generation can no longer add records.
        await this.dependencies.generationQueue(this.logger).stopRun(runId);

        try {
            const allUsers = await registryDb.collection<SimulatedUserRecord>('simulated_users')
                .find({ run_id: runId }).toArray();
            const users = includeKept ? allUsers : allUsers.filter((user) => user.retention_policy !== 'permanent');
            const devices = await registryDb.collection<SimulatedDeviceRecord>('simulated_devices')
                .find({ run_id: runId }).toArray();
            const devicesByAccount = new Map<string, SimulatedDeviceRecord[]>();
            for (const device of devices) {
                const list = devicesByAccount.get(device.simulator_user_id) ?? [];
                list.push(device);
                devicesByAccount.set(device.simulator_user_id, list);
            }

            const startedAt = new Date();
            const progress: CleanupProgress = {
                users_total: users.length,
                users_done: 0,
                users_blocked: 0,
                users_failed: 0,
                devices_total: users.reduce((sum, user) => sum + (devicesByAccount.get(user.account_id ?? '')?.length ?? 0), 0),
                devices_retired: 0,
                started_at: startedAt,
                updated_at: startedAt,
                blocked: [],
            };
            await this.saveProgress(runId, progress);
            const flusher = setInterval(() => void this.saveProgress(runId, progress).catch(() => undefined), PROGRESS_FLUSH_MS);
            flusher.unref?.();

            let accountsDeleted = 0;
            const queue = [...users];
            const worker = async () => {
                for (let user = queue.shift(); user && !this.stopping; user = queue.shift()) {
                    const userDevices = user.account_id ? devicesByAccount.get(user.account_id) ?? [] : [];
                    const outcome = await this.cleanUserWithRetries(run, user, userDevices);
                    if (outcome.state === 'cleaned') {
                        progress.users_done += 1;
                        progress.devices_retired += outcome.devices;
                        if (outcome.accountDeleted) accountsDeleted += 1;
                    } else {
                        if (outcome.state === 'blocked') progress.users_blocked += 1;
                        else progress.users_failed += 1;
                        if ((progress.blocked?.length ?? 0) < MAX_BLOCKED_KEPT) {
                            progress.blocked?.push({ account_id: user.account_id, email: user.email, reason: outcome.reason });
                        }
                    }
                    progress.updated_at = new Date();
                }
            };
            try {
                await Promise.all(Array.from({ length: Math.max(1, Math.min(this.dependencies.concurrency(), users.length)) }, worker));
            } finally {
                clearInterval(flusher);
                await this.saveProgress(runId, progress);
            }
            if (this.stopping && progress.users_done + progress.users_blocked + progress.users_failed < progress.users_total) {
                this.logger.info({ runId }, 'Cleanup paused by shutdown; it resumes at the next start');
                return { status: 'cleaning', progress };
            }
            const mediaStore = this.dependencies.mediaStore?.();
            if (mediaStore) await mediaStore.removeEmptyRunDir(runId).catch(() => undefined);

            const finishedAt = new Date();
            if (progress.users_blocked + progress.users_failed > 0) {
                // Blocked needs a person; failed only needs another try ("Dọn dữ liệu" again or the next sweep).
                const blocked = progress.users_blocked > 0;
                const message = blocked
                    ? `${progress.users_blocked} người dùng ảo cần xử lý bằng tay trước khi dọn${progress.users_failed ? `, ${progress.users_failed} người dùng gặp lỗi` : ''}; xem danh sách trong tiến độ dọn.`
                    : `${progress.users_failed} người dùng ảo chưa dọn được do lỗi; bấm "Dọn dữ liệu" để thử lại phần còn lại.`;
                await this.runs().updateOne(
                    { id: runId },
                    {
                        $set: { status: blocked ? 'cleanup_blocked' : 'cleanup_failed', last_cleanup_error: message, updated_at: finishedAt },
                        $inc: { cleanup_retries: 1 },
                    },
                );
                await this.dependencies.event({
                    type: blocked ? 'cleanup.blocked' : 'cleanup.failed',
                    severity: blocked ? 'warning' : 'error',
                    run_id: runId,
                    message,
                    data: { users: progress.blocked },
                }).catch(() => undefined);
                return { status: blocked ? 'cleanup_blocked' : 'cleanup_failed', accountsDeleted, devicesDeleted: progress.devices_retired, blocked: progress.blocked, progress };
            }

            const retainedUsers = allUsers.length - users.length;
            await this.runs().updateOne(
                { id: runId },
                retainedUsers > 0
                    ? {
                        $set: {
                            status: 'completed',
                            'config.cleanup_policy': 'manual',
                            updated_at: finishedAt,
                            last_cleanup_error: null,
                        },
                        $unset: { cleanup_after: '' },
                    }
                    : {
                        $set: {
                            status: 'cleaned',
                            cleaned_at: finishedAt,
                            updated_at: finishedAt,
                            last_cleanup_error: null,
                        },
                    },
            );
            await this.dependencies.event({
                type: 'cleanup.completed',
                severity: 'info',
                run_id: runId,
                message: 'Simulation run data was cleaned',
                data: {
                    accounts_deleted: accountsDeleted,
                    devices_deleted: progress.devices_retired,
                    retained_permanent_users: retainedUsers,
                    seconds: Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000),
                },
            }).catch(() => undefined);
            this.logger.info({ runId, accountsDeleted, devicesDeleted: progress.devices_retired, retainedUsers }, 'Simulation run cleanup completed');
            return { status: 'cleaned', accountsDeleted, devicesDeleted: progress.devices_retired, retainedUsers, progress };
        } catch (error) {
            await this.markCleanupFailure(runId, error);
            throw error;
        }
    }

    /** One user from the Console's user panel: a handful of requests, answered when done. */
    async cleanupUser(accountId: string): Promise<CleanupResult> {
        const registryDb = this.dependencies.registryDb();
        const user = await registryDb.collection<SimulatedUserRecord>('simulated_users').findOne({ account_id: accountId });
        if (!user) throw httpError(404, 'Simulated user not found');
        const run = await this.runs().findOne({ id: user.run_id });
        if (!run) throw httpError(404, 'Simulation run not found');
        if (['queued', 'running', 'paused', 'cleaning'].includes(run.status)) {
            throw httpError(409, 'A user cannot be cleaned while its simulation run is active');
        }
        const devices = await registryDb.collection<SimulatedDeviceRecord>('simulated_devices')
            .find({ simulator_user_id: accountId }).toArray();
        const outcome = await this.cleanUserWithRetries(run, user, devices);
        if (outcome.state !== 'cleaned') {
            await this.dependencies.event({
                type: 'cleanup.blocked',
                severity: 'warning',
                run_id: run.id,
                account_id: accountId,
                message: outcome.reason,
            }).catch(() => undefined);
            return { status: 'cleanup_blocked', blocked: [{ account_id: accountId, email: user.email, reason: outcome.reason }] };
        }
        await this.dependencies.event({
            type: 'cleanup.user_completed',
            severity: 'info',
            run_id: run.id,
            account_id: accountId,
            message: 'Simulated user and its devices were cleaned',
            data: { accounts_deleted: outcome.accountDeleted ? 1 : 0, devices_deleted: outcome.devices },
        }).catch(() => undefined);
        return { status: 'cleaned', accountsDeleted: outcome.accountDeleted ? 1 : 0, devicesDeleted: outcome.devices };
    }

    /** An error (not a block) is tried again after a short pause, up to three times. */
    private async cleanUserWithRetries(
        run: SimulationRun,
        user: SimulatedUserRecord,
        devices: SimulatedDeviceRecord[],
    ): Promise<UserOutcome> {
        let reason = '';
        for (let attempt = 1; attempt <= USER_ATTEMPTS; attempt += 1) {
            try {
                return await this.cleanUser(run, user, devices);
            } catch (error) {
                reason = `Lỗi khi dọn: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300);
                this.logger.warn({ err: error, runId: run.id, accountId: user.account_id, attempt }, 'Could not clean a simulated user');
                if (attempt < USER_ATTEMPTS && !this.stopping) await this.dependencies.sleep(2000 * attempt);
            }
        }
        return { state: 'failed', reason };
    }

    /** The four steps for one user; safe to repeat after an interruption. */
    private async cleanUser(
        run: SimulationRun,
        user: SimulatedUserRecord,
        devices: SimulatedDeviceRecord[],
    ): Promise<UserOutcome> {
        const registryDb = this.dependencies.registryDb();
        if (user.account_id && user.account_created_by_simulator !== true) {
            return { state: 'blocked', reason: 'Simulator chưa xác nhận được tài khoản này là của nó; không tự xóa.' };
        }
        const macs = devices.map((device) => device.mac);
        const manager = this.dependencies.runtimeManager(this.logger);
        await Promise.all(macs.map((mac) => manager.removeDevice(mac)));

        let accountDeleted = false;
        let signInFailed = false;
        if (user.account_id && !user.account_deleted_at) {
            let token: string | null = null;
            try {
                token = await this.dependencies.accessToken(user);
            } catch (error) {
                if (statusOf(error) !== 401) throw error;
                signInFailed = true;
            }
            if (token) {
                const asUser = async <T>(call: (accessToken: string) => Promise<T>): Promise<T> => {
                    try {
                        return await call(token!);
                    } catch (error) {
                        if (statusOf(error) !== 401) throw error;
                        token = await this.dependencies.accessToken(user, {}, { forceNew: true });
                        return call(token);
                    }
                };
                const tracked = new Set(macs);
                const owned = (await asUser((accessToken) => this.dependencies.gateway.listDevices(accessToken)))
                    .filter((device) => device.owner_id === user.account_id && tracked.has(device.mac));
                for (const device of owned) {
                    await asUser((accessToken) => this.dependencies.gateway.unpairDevice(accessToken, device.mac)).catch((error) => {
                        if (statusOf(error) !== 404) throw error;
                    });
                }
                try {
                    await asUser((accessToken) => this.dependencies.gateway.deleteAccount(accessToken, userPassword(user)));
                } catch (error) {
                    if (codeOf(error) === 'ACCOUNT_OWNS_DEVICES') {
                        return {
                            state: 'blocked',
                            reason: 'Tài khoản ảo đang sở hữu thiết bị không do Simulator tạo (đã được thêm bằng app). Gỡ thiết bị đó trong app rồi dọn lại.',
                        };
                    }
                    if (statusOf(error) !== 404) throw error;
                }
                accountDeleted = true;
                await registryDb.collection<SimulatedUserRecord>('simulated_users').updateOne(
                    { run_id: user.run_id, generation_index: user.generation_index },
                    { $set: { account_deleted_at: new Date(), updated_at: new Date() } },
                );
            }
        }

        // Retire at the factory: record, MQTT login and the system's data about the devices.
        let stillClaimed = 0;
        for (let index = 0; index < macs.length; index += RETIRE_BATCH) {
            const results = await this.dependencies.gateway.retireFactoryDevices(macs.slice(index, index + RETIRE_BATCH));
            stillClaimed += results.filter((result) => result.status === 'claimed').length;
        }
        if (stillClaimed > 0) {
            return {
                state: 'blocked',
                reason: signInFailed
                    ? `Không đăng nhập được tài khoản ảo và ${stillClaimed} thiết bị của nó vẫn có chủ trong hệ thống. Kiểm tra tài khoản này (mật khẩu có bị đổi trong app?) rồi dọn lại.`
                    : `${stillClaimed} thiết bị vẫn có chủ là một tài khoản khác. Chủ hiện tại phải gỡ thiết bị trong app trước khi dọn.`,
            };
        }
        if (signInFailed) {
            await this.dependencies.event({
                type: 'cleanup.account_unreachable',
                severity: 'warning',
                run_id: run.id,
                account_id: user.account_id,
                message: 'Không đăng nhập được tài khoản ảo (có thể đã xóa ở lần dọn trước); nó không còn sở hữu thiết bị nào của Simulator nên bản ghi được bỏ.',
            }).catch(() => undefined);
        }

        // Forget the records, then the virtual SD cards.
        await Promise.all([
            registryDb.collection('simulated_devices').deleteMany({ mac: { $in: macs } }),
            registryDb.collection('simulated_users').deleteOne({ run_id: user.run_id, generation_index: user.generation_index }),
        ]);
        const mediaStore = this.dependencies.mediaStore?.();
        if (mediaStore) {
            for (const device of devices) {
                await mediaStore.wipeCamera(device.run_id, device.mac).catch((error) => this.logger.warn(
                    { err: error, mac: device.mac },
                    'Failed to wipe virtual camera recordings during cleanup',
                ));
            }
        }
        return { state: 'cleaned', accountDeleted, devices: macs.length };
    }

    private async saveProgress(runId: string, progress: CleanupProgress): Promise<void> {
        await this.runs().updateOne(
            { id: runId },
            { $set: { cleanup_progress: { ...progress, blocked: [...(progress.blocked ?? [])] }, updated_at: new Date() } },
        );
    }

    private async markCleanupFailure(runId: string, error: unknown): Promise<void> {
        const message = error instanceof Error ? error.message : String(error);
        await this.runs().updateOne(
            { id: runId },
            {
                $set: {
                    status: 'cleanup_failed',
                    last_cleanup_error: message.slice(0, 1000),
                    updated_at: new Date(),
                },
                $inc: { cleanup_retries: 1 },
            },
        );
        await this.dependencies.event({
            type: 'cleanup.failed',
            severity: 'error',
            run_id: runId,
            message: 'Simulation run cleanup failed',
            data: { error: message },
        }).catch(() => undefined);
    }

    /** Runs left 'cleaning' by a restart continue in the background. */
    async recoverInterruptedCleanups(): Promise<void> {
        const interrupted = await this.runs().find({ status: 'cleaning' }).toArray();
        for (const run of interrupted) {
            void this.cleanupRun(run.id, 'cleaning').catch(error => {
                this.logger.error({ err: error, runId: run.id }, 'Interrupted cleanup recovery failed');
            });
        }
    }

    private async runCleanup(): Promise<void> {
        if (this.cleanupTask) return this.cleanupTask;
        const task = Promise.resolve().then(() => this.executeCleanupSweep()).finally(() => {
            if (this.cleanupTask === task) this.cleanupTask = null;
        });
        this.cleanupTask = task;
        return task;
    }

    private async executeCleanupSweep(): Promise<void> {
        if (this.cleanupRunning) return;
        this.cleanupRunning = true;
        try {
            const expiredRuns = await this.runs()
                .find({
                    'config.cleanup_policy': 'auto_24h',
                    status: { $in: ['completed', 'partial', 'failed', 'cancelled', 'cleanup_failed'] },
                    cleanup_after: { $lte: new Date() },
                })
                .toArray();
            for (const run of expiredRuns) {
                if (this.stopping) break;
                try {
                    await this.cleanupRun(run.id, run.status);
                } catch (error) {
                    this.logger.error({ err: error, runId: run.id }, 'Scheduled cleanup failed');
                }
            }
        } catch (error) {
            this.logger.error({ err: error }, 'Auto-cleanup scheduler iteration failed');
        } finally {
            this.cleanupRunning = false;
        }
    }
}
