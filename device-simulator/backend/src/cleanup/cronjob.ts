import type { FastifyBaseLogger } from 'fastify';
import argon2 from 'argon2';
import { env } from '../config/env';
import type { SimulationRun } from '../domain/simulation-run';
import type {
    SimulatedDeviceRecord,
    SimulatedUserRecord,
} from '../domain/registry';
import {
    getMainMongoDb,
    getMongoDb,
} from '../infrastructure/mongodb/client';
import { getPgPool } from '../infrastructure/postgres/client';
import { getRuntimeManager } from '../runtime/manager';
import { getGenerationQueue } from '../generation/queue';
import { recordSimulatorEvent } from '../events/service';
import { decrypt } from '../security/crypto';
import {
    decryptAccessToken,
    decryptRefreshToken,
    encryptAuthSession,
} from '../security/auth-session';
import { apiGateway } from '../infrastructure/api-gateway/client';
import { classifyAccountCleanupTargets } from './targets';

export interface CleanupResult {
    status: 'cleaned' | 'cleanup_blocked';
    accountsDeleted?: number;
    devicesDeleted?: number;
    retainedUsers?: number;
    untrackedDevices?: Array<{ owner_id: string; mac: string }>;
    unverifiedAccounts?: string[];
}

interface CleanupScope {
    kind: 'run' | 'user';
    accountId?: string;
}

const cleanupDependencies = {
    registryDb: getMongoDb, mainDb: getMainMongoDb, pgPool: getPgPool,
    runtimeManager: getRuntimeManager, generationQueue: getGenerationQueue,
    gateway: apiGateway, event: recordSimulatorEvent,
};

export class CleanupCronjob {
    private readonly logger: FastifyBaseLogger;
    private timer: NodeJS.Timeout | null = null;
    private cleanupRunning = false;
    private cleanupTask: Promise<void> | null = null;
    private readonly pendingRuns = new Map<string, Promise<CleanupResult>>();

    constructor(logger: FastifyBaseLogger, private readonly dependencies = cleanupDependencies) {
        this.logger = logger.child({ module: 'CleanupCronjob' });
    }

    start(): void {
        if (this.timer) return;
        this.logger.info({ intervalMs: env.CLEANUP_INTERVAL_MS }, 'Auto-cleanup scheduler started');
        void this.runCleanup();
        this.timer = setInterval(() => void this.runCleanup(), env.CLEANUP_INTERVAL_MS);
    }

    async stop(): Promise<void> {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        await this.cleanupTask;
        await Promise.allSettled([...this.pendingRuns.values()]);
    }

    async cleanupRun(runId: string, expectedStatus?: SimulationRun['status']): Promise<CleanupResult> {
        const pending = this.pendingRuns.get(runId);
        if (pending) return pending;
        const task = this.executeCleanupRun(runId, expectedStatus).finally(() => {
            if (this.pendingRuns.get(runId) === task) this.pendingRuns.delete(runId);
        });
        this.pendingRuns.set(runId, task);
        return task;
    }

    private async executeCleanupRun(runId: string, expectedStatus?: SimulationRun['status']): Promise<CleanupResult> {
        const registryDb = this.dependencies.registryDb();
        const run = await registryDb.collection<SimulationRun>('simulation_runs').findOne({ id: runId });
        if (!run) throw Object.assign(new Error('Simulation run not found'), { statusCode: 404 });
        if (run.status === 'cleaned') return { status: 'cleaned' };

        if (expectedStatus && run.status !== expectedStatus) {
            throw Object.assign(new Error('Run changed before scheduled cleanup'), { statusCode: 409 });
        }
        const claimed = await registryDb.collection<SimulationRun>('simulation_runs').updateOne(
            { id: runId, ...(expectedStatus ? { status: expectedStatus } : {}) },
            { $set: { status: 'cleaning', updated_at: new Date() } },
        );
        if (claimed?.matchedCount === 0) {
            throw Object.assign(new Error('Run changed before cleanup could start'), { statusCode: 409 });
        }
        // Take the cleanup snapshot only after generation can no longer add records.
        await this.dependencies.generationQueue(this.logger).stopRun(runId);

        const allUsers = await registryDb.collection<SimulatedUserRecord>('simulated_users')
            .find({ run_id: runId })
            .toArray();
        const users = allUsers.filter((user) => user.retention_policy !== 'permanent');
        const accountIds = new Set(users.flatMap((user) => user.account_id ? [user.account_id] : []));
        const devices = await registryDb.collection<SimulatedDeviceRecord>('simulated_devices')
            .find({ run_id: runId })
            .toArray();
        const selectedDevices = devices.filter((device) =>
            device.retention_policy !== 'permanent'
            && accountIds.has(device.simulator_user_id),
        );

        try {
            const result = await this.cleanupTargets(run, users, selectedDevices, { kind: 'run' });
            if (result.status === 'cleanup_blocked') return result;

            const cleanedAt = new Date();
            const retainedUsers = allUsers.length - users.length;
            const runUpdate = retainedUsers > 0
                ? {
                    $set: {
                        status: 'completed' as const,
                        'config.cleanup_policy': 'manual' as const,
                        updated_at: cleanedAt,
                        last_cleanup_error: null,
                    },
                    $unset: { cleanup_after: '' as const },
                }
                : {
                    $set: {
                        status: 'cleaned' as const,
                        cleaned_at: cleanedAt,
                        updated_at: cleanedAt,
                        last_cleanup_error: null,
                    },
                };
            await registryDb.collection<SimulationRun>('simulation_runs').updateOne(
                { id: runId },
                runUpdate,
            );
            await this.dependencies.event({
                type: 'cleanup.completed',
                severity: 'info',
                run_id: runId,
                message: 'Simulation run TTL data was cleaned successfully',
                data: {
                    accounts_deleted: result.accountsDeleted || 0,
                    devices_deleted: result.devicesDeleted || 0,
                    retained_permanent_users: retainedUsers,
                },
            }).catch(() => undefined);
            this.logger.info({
                runId,
                accountsDeleted: result.accountsDeleted,
                devicesDeleted: result.devicesDeleted,
                retainedUsers,
            }, 'Simulation run cleanup completed');
            return { ...result, retainedUsers };
        } catch (error) {
            await this.markCleanupFailure(runId, error);
            throw error;
        }
    }

    async cleanupUser(accountId: string): Promise<CleanupResult> {
        const registryDb = this.dependencies.registryDb();
        const user = await registryDb.collection<SimulatedUserRecord>('simulated_users')
            .findOne({ account_id: accountId });
        if (!user) throw Object.assign(new Error('Simulated user not found'), { statusCode: 404 });
        const run = await registryDb.collection<SimulationRun>('simulation_runs')
            .findOne({ id: user.run_id });
        if (!run) throw Object.assign(new Error('Simulation run not found'), { statusCode: 404 });
        if (['queued', 'running', 'paused', 'cleaning'].includes(run.status)) {
            throw Object.assign(
                new Error('A user cannot be cleaned while its simulation run is active'),
                { statusCode: 409 },
            );
        }

        const devices = await registryDb.collection<SimulatedDeviceRecord>('simulated_devices')
            .find({ simulator_user_id: accountId })
            .toArray();
        const result = await this.cleanupTargets(run, [user], devices, {
            kind: 'user',
            accountId,
        });
        if (result.status === 'cleaned') {
            await this.dependencies.event({
                type: 'cleanup.user_completed',
                severity: 'info',
                run_id: run.id,
                account_id: accountId,
                message: 'Simulated user and its tracked devices were cleaned successfully',
                data: {
                    accounts_deleted: result.accountsDeleted || 0,
                    devices_deleted: result.devicesDeleted || 0,
                },
            }).catch(() => undefined);
        }
        return result;
    }

    private async cleanupTargets(
        run: SimulationRun,
        users: SimulatedUserRecord[],
        devices: SimulatedDeviceRecord[],
        scope: CleanupScope,
    ): Promise<CleanupResult> {
        const registryDb = this.dependencies.registryDb();
        const {
            ownedAccountIds: accountIds,
            unverifiedAccountIds,
        } = classifyAccountCleanupTargets(users);
        if (unverifiedAccountIds.length > 0) {
            return this.blockCleanup(
                run.id,
                scope,
                'Registry contains accounts without verified simulator ownership',
                { unverified_account_ids: unverifiedAccountIds },
                { status: 'cleanup_blocked', unverifiedAccounts: unverifiedAccountIds },
            );
        }

        const ownedFactoryMacs: string[] = [];
        const trackedMacs = devices.map(device => device.mac);
        if (trackedMacs.length > 0) {
            const transferred = await this.dependencies.pgPool().query<{ owner_id: string; mac: string }>(
                `SELECT owner_id::text, mac FROM device_metadata
                 WHERE mac = ANY($1::text[]) AND is_active = true
                   AND NOT (owner_id = ANY($2::uuid[]))`,
                [trackedMacs, accountIds],
            );
            if (transferred.rows.length > 0) {
                return this.blockCleanup(run.id, scope, 'Tracked device is now owned by another account',
                    { transferred_devices: transferred.rows },
                    { status: 'cleanup_blocked', untrackedDevices: transferred.rows });
            }
        }
        for (const device of devices) {
            if (device.factory_owned) {
                ownedFactoryMacs.push(device.mac);
                continue;
            }
            const factoryRecord = await this.dependencies.pgPool().query<{ secret_key_hash: string }>(
                'SELECT secret_key_hash FROM factory_devices WHERE mac = $1',
                [device.mac],
            );
            if (factoryRecord.rows.length !== 1) continue;
            const rawSecret = decrypt(
                device.secret.iv,
                device.secret.encrypted,
                device.secret.authTag,
            );
            const secretMatches = await argon2.verify(
                factoryRecord.rows[0].secret_key_hash,
                rawSecret,
            ).catch(() => false);
            if (secretMatches) ownedFactoryMacs.push(device.mac);
        }

        const trackedByOwner = new Map<string, Set<string>>();
        for (const device of devices) {
            const tracked = trackedByOwner.get(device.simulator_user_id) || new Set<string>();
            tracked.add(device.mac);
            trackedByOwner.set(device.simulator_user_id, tracked);
        }
        if (accountIds.length > 0) {
            const ownedDevices = await this.dependencies.pgPool().query<{ owner_id: string; mac: string }>(
                `SELECT membership.account_id::text AS owner_id, device.mac
                 FROM device_memberships AS membership
                 JOIN device_metadata AS device ON device.id = membership.device_id
                 WHERE membership.account_id = ANY($1::uuid[])
                   AND membership.role = 'owner'
                   AND membership.status = 'active'`,
                [accountIds],
            );
            const untrackedDevices = ownedDevices.rows.filter((row) =>
                !trackedByOwner.get(row.owner_id)?.has(row.mac),
            );
            if (untrackedDevices.length > 0) {
                return this.blockCleanup(
                    run.id,
                    scope,
                    'Generated account owns devices outside this simulator registry',
                    { untracked_devices: untrackedDevices },
                    { status: 'cleanup_blocked', untrackedDevices },
                );
            }
        }

        const macs = devices.map((device) => device.mac);
        const runtimeManager = this.dependencies.runtimeManager(this.logger);
        await Promise.all(macs.map((mac) => runtimeManager.removeDevice(mac)));

        const devicesByAccount = new Map<string, SimulatedDeviceRecord[]>();
        for (const device of devices) {
            const accountDevices = devicesByAccount.get(device.simulator_user_id) || [];
            accountDevices.push(device);
            devicesByAccount.set(device.simulator_user_id, accountDevices);
        }
        const existingAccounts = accountIds.length > 0
            ? await this.dependencies.pgPool().query<{ id: string }>(
                'SELECT id::text FROM accounts WHERE id = ANY($1::uuid[])',
                [accountIds],
            )
            : { rows: [] };
        const existingAccountIds = new Set(existingAccounts.rows.map(account => account.id));
        const unpairedMacs = new Set(scope.kind === 'run' ? run.cleanup_unpaired_macs || [] : []);
        for (const user of users) {
            if (!user.account_id) continue;
            // A crash after the PostgreSQL commit must not require login to a deleted account.
            if (!existingAccountIds.has(user.account_id)) continue;
            const accountDevices = (devicesByAccount.get(user.account_id) || [])
                .filter(device => !unpairedMacs.has(device.mac));
            if (accountDevices.length === 0) continue;
            let accessToken = await this.getCleanupAccessToken(user, false);
            for (const device of accountDevices) {
                try {
                    await this.dependencies.gateway.unpairDevice(accessToken, device.mac);
                } catch (error) {
                    const statusCode = Number((error as { statusCode?: number }).statusCode || 0);
                    if (statusCode !== 404) {
                        if (statusCode !== 401) throw error;
                        accessToken = await this.getCleanupAccessToken(user, true);
                        try {
                            await this.dependencies.gateway.unpairDevice(accessToken, device.mac);
                        } catch (retryError) {
                            if (Number((retryError as { statusCode?: number }).statusCode) !== 404) throw retryError;
                        }
                    }
                }
                if (scope.kind === 'run') {
                    await registryDb.collection<SimulationRun>('simulation_runs').updateOne(
                        { id: run.id },
                        { $addToSet: { cleanup_unpaired_macs: device.mac } },
                    );
                }
            }
        }

        // Retire the factory identities on the broker before their factory records
        // disappear; revocation is idempotent, so an interrupted cleanup can repeat it.
        await Promise.all(ownedFactoryMacs.map(mac => runtimeManager.revokeBrokerIdentity(mac)));

        const pgClient = await this.dependencies.pgPool().connect();
        try {
            await pgClient.query('BEGIN');
            if (accountIds.length > 0) {
                await pgClient.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [accountIds]);
            }
            if (ownedFactoryMacs.length > 0) {
                await pgClient.query(
                    'DELETE FROM factory_devices WHERE mac = ANY($1::text[])',
                    [ownedFactoryMacs],
                );
            }
            await pgClient.query('COMMIT');
        } catch (error) {
            await pgClient.query('ROLLBACK');
            throw error;
        } finally {
            pgClient.release();
        }

        if (macs.length > 0) {
            const mainDb = this.dependencies.mainDb();
            await Promise.all([
                mainDb.collection<{ _id: string }>(env.MAIN_MONGO_DEVICE_SHADOWS_COLLECTION).deleteMany({
                    _id: { $in: macs },
                }),
                mainDb.collection(env.MAIN_MONGO_TELEMETRY_COLLECTION).deleteMany({
                    'metadata.device_id': { $in: macs },
                }),
                mainDb.collection('active_operations').deleteMany({
                    device_id: { $in: macs },
                }),
                mainDb.collection(env.MAIN_MONGO_DEVICE_EVENTS_COLLECTION).deleteMany({
                    device_id: { $in: macs },
                }),
                mainDb.collection('device_incidents').deleteMany({
                    device_id: { $in: macs },
                }),
                mainDb.collection(env.MAIN_MONGO_INGEST_RECEIPTS_COLLECTION).deleteMany({
                    device_id: { $in: macs },
                }),
            ]);
        }

        const userFilter = scope.kind === 'user'
            ? { account_id: scope.accountId }
            : {
                run_id: run.id,
                retention_policy: { $ne: 'permanent' },
                $or: [
                    { account_id: { $in: accountIds } },
                    { account_id: { $exists: false } },
                ],
            };
        const deviceFilter = scope.kind === 'user'
            ? { simulator_user_id: scope.accountId }
            : {
                run_id: run.id,
                simulator_user_id: { $in: accountIds },
                retention_policy: { $ne: 'permanent' },
            };
        await Promise.all([
            registryDb.collection('simulated_users').deleteMany(userFilter),
            registryDb.collection('simulated_devices').deleteMany(deviceFilter),
        ]);
        return {
            status: 'cleaned',
            accountsDeleted: accountIds.length,
            devicesDeleted: macs.length,
        };
    }

    private async getCleanupAccessToken(
        user: SimulatedUserRecord,
        forceRefresh: boolean,
    ): Promise<string> {
        if (user.auth_session && !forceRefresh) {
            return decryptAccessToken(user.auth_session);
        }

        let session;
        if (user.auth_session) {
            try {
                session = await this.dependencies.gateway.refreshSession({
                    sessionId: user.auth_session.session_id,
                    refreshToken: decryptRefreshToken(user.auth_session),
                });
            } catch {
                session = undefined;
            }
        }
        if (!session) {
            session = await this.dependencies.gateway.login({
                email: user.email,
                password: decrypt(
                    user.credential.iv,
                    user.credential.encrypted,
                    user.credential.authTag,
                ),
            });
        }

        user.auth_session = encryptAuthSession(session);
        await this.dependencies.registryDb().collection<SimulatedUserRecord>('simulated_users').updateOne(
            { run_id: user.run_id, account_id: user.account_id },
            { $set: { auth_session: user.auth_session, updated_at: new Date() } },
        );
        return session.accessToken;
    }

    private async blockCleanup(
        runId: string,
        scope: CleanupScope,
        message: string,
        data: Record<string, unknown>,
        result: CleanupResult,
    ): Promise<CleanupResult> {
        if (scope.kind === 'run') {
            await this.dependencies.registryDb().collection<SimulationRun>('simulation_runs').updateOne(
                { id: runId },
                {
                    $set: {
                        status: 'cleanup_blocked',
                        last_cleanup_error: message,
                        updated_at: new Date(),
                    },
                    $inc: { cleanup_retries: 1 },
                },
            );
        }
        await this.dependencies.event({
            type: 'cleanup.blocked',
            severity: 'warning',
            run_id: runId,
            account_id: scope.accountId,
            message,
            data,
        }).catch(() => undefined);
        return result;
    }

    private async markCleanupFailure(runId: string, error: unknown): Promise<void> {
        const message = error instanceof Error ? error.message : String(error);
        await this.dependencies.registryDb().collection<SimulationRun>('simulation_runs').updateOne(
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

    async recoverInterruptedCleanups(): Promise<void> {
        const interrupted = await this.dependencies.registryDb().collection<SimulationRun>('simulation_runs')
            .find({ status: 'cleaning' }).toArray();
        for (const run of interrupted) {
            await this.cleanupRun(run.id, 'cleaning').catch(error => {
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
            const expiredRuns = await this.dependencies.registryDb().collection<SimulationRun>('simulation_runs')
                .find({
                    $or: [
                        { status: 'cleaning' },
                        {
                            'config.cleanup_policy': 'auto_24h',
                            status: { $in: ['completed', 'partial', 'failed', 'cancelled', 'cleanup_failed'] },
                            cleanup_after: { $lte: new Date() },
                        },
                    ],
                })
                .toArray();
            for (const run of expiredRuns) {
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
