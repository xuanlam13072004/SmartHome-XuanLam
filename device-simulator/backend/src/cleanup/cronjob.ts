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

export class CleanupCronjob {
    private readonly logger: FastifyBaseLogger;
    private timer: NodeJS.Timeout | null = null;
    private cleanupRunning = false;

    constructor(logger: FastifyBaseLogger) {
        this.logger = logger.child({ module: 'CleanupCronjob' });
    }

    start(): void {
        if (this.timer) return;
        this.logger.info({ intervalMs: env.CLEANUP_INTERVAL_MS }, 'Auto-cleanup scheduler started');
        void this.runCleanup();
        this.timer = setInterval(() => void this.runCleanup(), env.CLEANUP_INTERVAL_MS);
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    async cleanupRun(runId: string): Promise<CleanupResult> {
        const registryDb = getMongoDb();
        const run = await registryDb.collection<SimulationRun>('simulation_runs').findOne({ id: runId });
        if (!run) throw Object.assign(new Error('Simulation run not found'), { statusCode: 404 });
        if (run.status === 'cleaned') return { status: 'cleaned' };

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

        await registryDb.collection<SimulationRun>('simulation_runs').updateOne(
            { id: runId },
            { $set: { status: 'cleaning', updated_at: new Date() } },
        );
        getGenerationQueue(this.logger).stopRun(runId);

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
            await recordSimulatorEvent({
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
        const registryDb = getMongoDb();
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
            await recordSimulatorEvent({
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
        const registryDb = getMongoDb();
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
        for (const device of devices) {
            if (device.factory_owned) {
                ownedFactoryMacs.push(device.mac);
                continue;
            }
            const factoryRecord = await getPgPool().query<{ secret_key: string }>(
                'SELECT secret_key FROM factory_devices WHERE mac = $1',
                [device.mac],
            );
            if (factoryRecord.rows.length !== 1) continue;
            const rawSecret = decrypt(
                device.secret.iv,
                device.secret.encrypted,
                device.secret.authTag,
            );
            const secretMatches = await argon2.verify(
                factoryRecord.rows[0].secret_key,
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
            const ownedDevices = await getPgPool().query<{ owner_id: string; mac: string }>(
                `SELECT owner_id::text, mac
                 FROM device_metadata
                 WHERE owner_id = ANY($1::uuid[])`,
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
        const runtimeManager = getRuntimeManager(this.logger);
        await Promise.all(macs.map((mac) => runtimeManager.removeDevice(mac)));

        const pgClient = await getPgPool().connect();
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
            const mainDb = getMainMongoDb();
            await Promise.all([
                mainDb.collection<{ _id: string }>(env.MAIN_MONGO_DEVICES_COLLECTION).deleteMany({
                    _id: { $in: macs },
                }),
                mainDb.collection(env.MAIN_MONGO_TELEMETRY_COLLECTION).deleteMany({
                    'metadata.device_id': { $in: macs },
                }),
                mainDb.collection('active_commands').deleteMany({
                    $or: [{ mac: { $in: macs } }, { device_id: { $in: macs } }],
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

    private async blockCleanup(
        runId: string,
        scope: CleanupScope,
        message: string,
        data: Record<string, unknown>,
        result: CleanupResult,
    ): Promise<CleanupResult> {
        if (scope.kind === 'run') {
            await getMongoDb().collection<SimulationRun>('simulation_runs').updateOne(
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
        await recordSimulatorEvent({
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
        await getMongoDb().collection<SimulationRun>('simulation_runs').updateOne(
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
        await recordSimulatorEvent({
            type: 'cleanup.failed',
            severity: 'error',
            run_id: runId,
            message: 'Simulation run cleanup failed',
            data: { error: message },
        }).catch(() => undefined);
    }

    private async runCleanup(): Promise<void> {
        if (this.cleanupRunning) return;
        this.cleanupRunning = true;
        try {
            const expiredRuns = await getMongoDb().collection<SimulationRun>('simulation_runs')
                .find({
                    'config.cleanup_policy': 'auto_24h',
                    status: { $in: ['completed', 'partial', 'failed', 'cancelled', 'cleanup_failed'] },
                    cleanup_after: { $lte: new Date() },
                })
                .toArray();
            for (const run of expiredRuns) {
                try {
                    await this.cleanupRun(run.id);
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
