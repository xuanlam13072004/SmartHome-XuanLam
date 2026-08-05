import type { FastifyBaseLogger } from 'fastify';
import type { SimulationRun, RunStatus } from '../domain/simulation-run';
import type {
    SimulatedDeviceRecord,
    SimulatedUserRecord,
} from '../domain/registry';
import { env } from '../config/env';
import { getMongoDb } from '../infrastructure/mongodb/client';
import { getPgPool } from '../infrastructure/postgres/client';
import { generateUser } from './user-generator';
import { apiGateway } from '../infrastructure/api-gateway/client';
import {
    createMockDeviceIdentity,
    provisionMockDevice,
} from '../provisioning/factory';
import { decrypt, encrypt } from '../security/crypto';
import { getRuntimeManager } from '../runtime/manager';
import {
    deterministicInteger,
    deterministicUnit,
} from './deterministic';
import { verifyRecoverableGeneratedAccount } from './account-ownership';
import { recordSimulatorEvent } from '../events/service';
import { encryptAuthSession } from '../security/auth-session';
import type { ClaimedDevice } from '../infrastructure/api-gateway/client';
import {
    assignmentFromClaim,
    chooseNetworkCount,
    createNetworkFingerprint,
    networkIndexForDevice,
} from '../runtime/topology';
import { getProduct } from '../catalog/loader';

const delay = (milliseconds: number) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));

interface AccountRow {
    id: string;
    email: string;
    full_name: string | null;
    created_at: Date;
}

type LoginSession = Awaited<ReturnType<typeof apiGateway.login>>;

export class GenerationQueue {
    private readonly logger: FastifyBaseLogger;
    private readonly runningTasks = new Set<string>();

    constructor(logger: FastifyBaseLogger) {
        this.logger = logger.child({ module: 'GenerationQueue' });
    }

    isRunning(runId: string): boolean {
        return this.runningTasks.has(runId);
    }

    async startRun(runInput: SimulationRun): Promise<void> {
        if (this.runningTasks.has(runInput.id)) return;
        this.runningTasks.add(runInput.id);

        const db = getMongoDb();
        const run = await db.collection<SimulationRun>('simulation_runs').findOne({ id: runInput.id });
        if (!run || ['cancelled', 'cleaning', 'cleaned', 'cleanup_blocked'].includes(run.status)) {
            this.runningTasks.delete(runInput.id);
            return;
        }

        this.logger.info({ runId: run.id }, 'Simulation generation started or resumed');
        await this.updateRunStatus(run.id, 'running', {
            started_at: run.started_at || new Date(),
        });
        await this.safeEvent({
            type: 'run.started',
            severity: 'info',
            run_id: run.id,
            message: run.started_at ? 'Simulation run resumed' : 'Simulation run started',
        });

        try {
            for (let index = 0; index < run.config.user_count; index += 1) {
                if (!this.runningTasks.has(run.id)) {
                    this.logger.info({ runId: run.id }, 'Simulation generation stopped');
                    return;
                }

                try {
                    await this.processUserGeneration(run, index);
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    this.logger.error({ err: error, runId: run.id, userIndex: index }, 'User generation failed');
                    await this.recordError(run.id, message);
                    await db.collection<SimulatedUserRecord>('simulated_users').updateOne(
                        { run_id: run.id, generation_index: index },
                        {
                            $set: {
                                status: 'failed',
                                generation_state: 'failed',
                                last_error: message,
                                updated_at: new Date(),
                            },
                        },
                    );
                    await this.safeEvent({
                        type: 'user.failed',
                        severity: 'error',
                        run_id: run.id,
                        message: `Failed to generate user at index ${index}`,
                        data: { generation_index: index, error: message },
                    });
                }

                await this.syncProgress(run.id);
                if (index < run.config.user_count - 1 && env.REGISTRATION_DELAY_MS > 0) {
                    await delay(env.REGISTRATION_DELAY_MS);
                }
            }

            if (!this.runningTasks.has(run.id)) return;

            await this.syncProgress(run.id);
            const refreshed = await db.collection<SimulationRun>('simulation_runs').findOne({ id: run.id });
            const completedAt = new Date();
            const status: RunStatus = (refreshed?.total_errors || 0) > 0 ? 'partial' : 'completed';
            const cleanupAfter = run.config.cleanup_policy === 'auto_24h'
                ? new Date(completedAt.getTime() + env.CLEANUP_RETENTION_HOURS * 60 * 60 * 1000)
                : undefined;

            const completionFields: Record<string, unknown> = {
                completed_at: completedAt,
                cleanup_after: cleanupAfter,
            };
            await this.updateRunStatus(run.id, status, completionFields);

            const retentionPolicy = run.config.cleanup_policy === 'auto_24h' ? 'ttl' : 'permanent';
            const retentionFilter = retentionPolicy === 'ttl'
                ? { run_id: run.id, retention_policy: { $ne: 'permanent' as const } }
                : { run_id: run.id };
            await Promise.all([
                db.collection('simulated_users').updateMany(
                    retentionFilter,
                    {
                        $set: {
                            retention_policy: retentionPolicy,
                            expires_at: cleanupAfter,
                            updated_at: completedAt,
                        },
                    },
                ),
                db.collection('simulated_devices').updateMany(
                    retentionFilter,
                    {
                        $set: {
                            retention_policy: retentionPolicy,
                            expires_at: cleanupAfter,
                            updated_at: completedAt,
                        },
                    },
                ),
            ]);
            await this.safeEvent({
                type: 'run.completed',
                severity: status === 'partial' ? 'warning' : 'info',
                run_id: run.id,
                message: status === 'partial'
                    ? 'Simulation run completed with errors'
                    : 'Simulation run completed',
                data: { status, cleanup_after: cleanupAfter?.toISOString() },
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error({ err: error, runId: run.id }, 'Simulation run failed');
            await this.recordError(run.id, message);
            await this.updateRunStatus(run.id, 'failed', {
                completed_at: new Date(),
                cleanup_after: run.config.cleanup_policy === 'auto_24h'
                    ? new Date(Date.now() + env.CLEANUP_RETENTION_HOURS * 60 * 60 * 1000)
                    : undefined,
            });
            await this.safeEvent({
                type: 'run.failed',
                severity: 'error',
                run_id: run.id,
                message: 'Simulation run failed',
                data: { error: message },
            });
        } finally {
            this.runningTasks.delete(run.id);
        }
    }

    stopRun(runId: string): void {
        this.runningTasks.delete(runId);
    }

    private async processUserGeneration(run: SimulationRun, index: number): Promise<void> {
        const db = getMongoDb();
        const seed = run.config.random_seed || run.id;
        let user: SimulatedUserRecord | null =
            await db.collection<SimulatedUserRecord>('simulated_users').findOne({
            run_id: run.id,
            generation_index: index,
        });

        if (!user) {
            const generated = generateUser(
                index,
                run.id,
                run.config.email_domain,
                run.config.email_prefix,
                seed,
            );
            const targetDeviceCount = deterministicInteger(
                seed,
                `user:${index}:device-count`,
                run.config.devices_min,
                run.config.devices_max,
            );
            const now = new Date();
            const record: SimulatedUserRecord = {
                run_id: run.id,
                generation_index: index,
                email: generated.email,
                full_name: generated.full_name,
                credential: encrypt(generated.password),
                target_device_count: targetDeviceCount,
                generation_state: 'planned',
                status: 'active',
                retention_policy: run.config.cleanup_policy === 'auto_24h' ? 'ttl' : 'permanent',
                created_at: now,
                updated_at: now,
            };
            await db.collection<SimulatedUserRecord>('simulated_users').insertOne(record);
            user = record;
        }
        if (!user) throw new Error(`Failed to initialize simulated user ${index}`);

        const password = decrypt(
            user.credential.iv,
            user.credential.encrypted,
            user.credential.authTag,
        );

        let accountId = user.account_id;
        let session: LoginSession | null = null;
        let accountProvenance: SimulatedUserRecord['account_provenance'];
        if (!accountId) {
            const existingAccount = await getPgPool().query<AccountRow>(
                `SELECT id::text, email, full_name, created_at
                 FROM accounts
                 WHERE email = $1`,
                [user.email.toLowerCase()],
            );
            if (existingAccount.rows.length > 0) {
                session = await this.loginForOwnershipRecovery(user.email, password);
                const authenticated = await apiGateway.getCurrentUser(session.accessToken);
                accountId = verifyRecoverableGeneratedAccount(
                    {
                        email: user.email,
                        full_name: user.full_name,
                        registry_created_at: user.created_at,
                    },
                    {
                        ...existingAccount.rows[0],
                        created_at: new Date(existingAccount.rows[0].created_at),
                    },
                    authenticated,
                );
                accountProvenance = 'recovered_after_register';
            } else {
                const registered = await apiGateway.register({
                    email: user.email,
                    password,
                    full_name: user.full_name,
                });
                accountId = registered.id;
                accountProvenance = 'registered';
            }

            await db.collection<SimulatedUserRecord>('simulated_users').updateOne(
                { run_id: run.id, generation_index: index },
                {
                    $set: {
                        account_id: accountId,
                        account_created_by_simulator: true,
                        account_provenance: accountProvenance,
                        generation_state: 'registered',
                        updated_at: new Date(),
                    },
                },
            );
            await this.safeEvent({
                type: accountProvenance === 'registered'
                    ? 'user.registered'
                    : 'user.registration_recovered',
                severity: 'info',
                run_id: run.id,
                account_id: accountId,
                message: accountProvenance === 'registered'
                    ? `Registered simulated user ${user.email}`
                    : `Recovered previously registered simulated user ${user.email}`,
            });
        } else if (user.account_created_by_simulator !== true) {
            const existingAccount = await getPgPool().query<AccountRow>(
                `SELECT id::text, email, full_name, created_at
                 FROM accounts
                 WHERE id = $1`,
                [accountId],
            );
            if (existingAccount.rows.length !== 1) {
                throw new Error('ACCOUNT_OWNERSHIP_UNVERIFIED: registry account no longer exists');
            }
            session = await this.loginForOwnershipRecovery(user.email, password);
            const authenticated = await apiGateway.getCurrentUser(session.accessToken);
            accountId = verifyRecoverableGeneratedAccount(
                {
                    email: user.email,
                    full_name: user.full_name,
                    registry_created_at: user.created_at,
                },
                {
                    ...existingAccount.rows[0],
                    created_at: new Date(existingAccount.rows[0].created_at),
                },
                authenticated,
            );
            accountProvenance = 'recovered_after_register';
            await db.collection<SimulatedUserRecord>('simulated_users').updateOne(
                { run_id: run.id, generation_index: index },
                {
                    $set: {
                        account_created_by_simulator: true,
                        account_provenance: accountProvenance,
                        updated_at: new Date(),
                    },
                },
            );
            await this.safeEvent({
                type: 'user.ownership_verified',
                severity: 'info',
                run_id: run.id,
                account_id: accountId,
                message: `Recovered and verified simulator account ownership for ${user.email}`,
            });
        }

        session ||= await apiGateway.login({ email: user.email, password });
        await db.collection<SimulatedUserRecord>('simulated_users').updateOne(
            { run_id: run.id, generation_index: index },
            {
                $set: {
                    generation_state: 'provisioning',
                    auth_session: encryptAuthSession(session),
                    updated_at: new Date(),
                },
            },
        );

        for (let deviceIndex = 0; deviceIndex < user.target_device_count; deviceIndex += 1) {
            if (!this.runningTasks.has(run.id)) return;
            await this.ensureDevice(run, {
                accountId,
                userIndex: index,
                deviceIndex,
                targetDeviceCount: user.target_device_count,
                accessToken: session.accessToken,
            });
            if (deviceIndex < user.target_device_count - 1 && env.CLAIM_DELAY_MS > 0) {
                await delay(env.CLAIM_DELAY_MS);
            }
        }

        await db.collection<SimulatedUserRecord>('simulated_users').updateOne(
            { run_id: run.id, generation_index: index },
            {
                $set: {
                    generation_state: 'ready',
                    status: 'active',
                    last_error: null,
                    updated_at: new Date(),
                },
            },
        );
    }

    private async loginForOwnershipRecovery(
        email: string,
        password: string,
    ): Promise<LoginSession> {
        try {
            return await apiGateway.login({ email, password });
        } catch {
            throw new Error(
                'ACCOUNT_IDENTITY_COLLISION: existing email is not controlled by this simulator identity',
            );
        }
    }

    private async ensureDevice(
        run: SimulationRun,
        input: {
            accountId: string;
            userIndex: number;
            deviceIndex: number;
            targetDeviceCount: number;
            accessToken: string;
        },
    ): Promise<void> {
        const db = getMongoDb();
        const seed = run.config.random_seed || run.id;
        const configuredNetworkCount = deterministicInteger(
            seed,
            `user:${input.userIndex}:network-count`,
            run.config.networks_min ?? 1,
            run.config.networks_max ?? 1,
        );
        const networkCount = chooseNetworkCount(
            input.targetDeviceCount,
            configuredNetworkCount,
        );
        const simulatedNetworkIndex = networkIndexForDevice(
            input.deviceIndex,
            networkCount,
        );
        const networkFingerprint = createNetworkFingerprint(
            seed,
            run.id,
            input.userIndex,
            simulatedNetworkIndex,
        );
        let device: SimulatedDeviceRecord | null =
            await db.collection<SimulatedDeviceRecord>('simulated_devices').findOne({
            run_id: run.id,
            simulator_user_id: input.accountId,
            generation_index: input.deviceIndex,
        });

        if (!device) {
            const product = this.pickProduct(run, input.userIndex, input.deviceIndex);
            const identity = await this.createAvailableDeviceIdentity(
                seed,
                `run:${run.id}:user:${input.userIndex}:device:${input.deviceIndex}`,
            );
            const now = new Date();
            const desiredState = run.config.auto_start
                && deterministicUnit(seed, `user:${input.userIndex}:device:${input.deviceIndex}:online`)
                    >= run.config.initial_offline_rate / 100
                ? 'online'
                : 'offline';
            const record: SimulatedDeviceRecord = {
                run_id: run.id,
                simulator_user_id: input.accountId,
                generation_index: input.deviceIndex,
                mac: identity.mac,
                name: `Virtual Device ${input.userIndex + 1}-${input.deviceIndex + 1}`,
                product_id: product.product_id,
                simulated_network_index: simulatedNetworkIndex,
                network_fingerprint: networkFingerprint,
                secret: encrypt(identity.rawSecret),
                credential_private_key: encrypt(identity.credentialPrivateKeyPem),
                credential_public_key_pem: identity.credentialPublicKeyPem,
                factory_owned: false,
                provisioning_state: 'planned',
                runtime_state: 'offline',
                desired_state: desiredState,
                seq: 0,
                retention_policy: run.config.cleanup_policy === 'auto_24h' ? 'ttl' : 'permanent',
                created_at: now,
                updated_at: now,
            };
            await db.collection<SimulatedDeviceRecord>('simulated_devices').insertOne(record);
            device = record;
        } else if (!device.network_fingerprint) {
            await db.collection<SimulatedDeviceRecord>('simulated_devices').updateOne(
                { mac: device.mac },
                {
                    $set: {
                        simulated_network_index: simulatedNetworkIndex,
                        network_fingerprint: networkFingerprint,
                        updated_at: new Date(),
                    },
                },
            );
            device.simulated_network_index = simulatedNetworkIndex;
            device.network_fingerprint = networkFingerprint;
        }
        if (!device) throw new Error(`Failed to initialize virtual device ${input.deviceIndex}`);

        const rawSecret = decrypt(device.secret.iv, device.secret.encrypted, device.secret.authTag);
        if (device.provisioning_state === 'planned' || device.provisioning_state === 'failed') {
            await provisionMockDevice(getProduct(device.product_id), {
                mac: device.mac,
                rawSecret,
                credentialPublicKeyPem: device.credential_public_key_pem,
                credentialPrivateKeyPem: decrypt(
                    device.credential_private_key.iv,
                    device.credential_private_key.encrypted,
                    device.credential_private_key.authTag,
                ),
            });
            await db.collection<SimulatedDeviceRecord>('simulated_devices').updateOne(
                { mac: device.mac },
                {
                    $set: {
                        provisioning_state: 'provisioned',
                        factory_owned: true,
                        last_error: null,
                        updated_at: new Date(),
                    },
                },
            );
            device.provisioning_state = 'provisioned';
            await this.safeEvent({
                type: 'device.provisioned',
                severity: 'info',
                run_id: run.id,
                account_id: input.accountId,
                mac: device.mac,
                message: `Provisioned virtual factory device ${device.mac}`,
            });
        }

        if (device.provisioning_state !== 'claimed') {
            let claimedDevice: ClaimedDevice | null = null;
            try {
                claimedDevice = await apiGateway.claimDevice(input.accessToken, {
                    mac: device.mac,
                    secret_key: rawSecret,
                    name: device.name,
                    network_fingerprint: device.network_fingerprint,
                });
            } catch (error) {
                const existing = await getPgPool().query(
                    `SELECT d.id, d.mac, d.owner_id, d.product_id, d.network_id,
                            d.join_rank, n.active_hub_device_id,
                            n.topology_epoch, n.topology_state,
                            hub.mac AS active_hub_mac,
                            CASE
                                WHEN d.id = n.active_hub_device_id THEN 'hub'
                                ELSE 'node'
                            END AS topology_role
                     FROM device_metadata AS d
                     LEFT JOIN device_networks AS n ON n.id = d.network_id
                     LEFT JOIN device_metadata AS hub
                            ON hub.id = n.active_hub_device_id
                     WHERE d.owner_id = $1 AND d.mac = $2 AND d.is_active = true`,
                    [input.accountId, device.mac],
                );
                if (existing.rows.length === 0) throw error;
                claimedDevice = {
                    id: String(existing.rows[0].id),
                    mac: String(existing.rows[0].mac),
                    owner_id: String(existing.rows[0].owner_id),
                    product_id: String(existing.rows[0].product_id),
                    network_id: existing.rows[0].network_id
                        ? String(existing.rows[0].network_id)
                        : null,
                    join_rank: existing.rows[0].join_rank,
                    topology_role: existing.rows[0].topology_role,
                    topology_epoch: existing.rows[0].topology_epoch,
                    topology_state: existing.rows[0].topology_state,
                    active_hub_device_id: existing.rows[0].active_hub_device_id
                        ? String(existing.rows[0].active_hub_device_id)
                        : null,
                    active_hub_mac: existing.rows[0].active_hub_mac
                        ? String(existing.rows[0].active_hub_mac)
                        : null,
                };
            }

            const assignment = assignmentFromClaim(claimedDevice);
            await db.collection<SimulatedDeviceRecord>('simulated_devices').updateOne(
                { mac: device.mac },
                {
                    $set: {
                        device_id: claimedDevice.id,
                        provisioning_state: 'claimed',
                        runtime_state: 'claimed',
                        ...(assignment ? {
                            network_id: assignment.network_id,
                            join_rank: assignment.join_rank,
                            topology_role: assignment.role,
                            topology_epoch: assignment.topology_epoch,
                            topology_state: assignment.topology_state,
                            active_hub_mac: assignment.active_hub_mac,
                            transport_mode: assignment.transport_mode,
                        } : {}),
                        last_error: null,
                        updated_at: new Date(),
                    },
                },
            );
            device.provisioning_state = 'claimed';
            device.device_id = claimedDevice.id;
            if (assignment) {
                device.network_id = assignment.network_id;
                device.join_rank = assignment.join_rank;
                device.topology_role = assignment.role;
                device.topology_epoch = assignment.topology_epoch;
                device.topology_state = assignment.topology_state;
                device.active_hub_mac = assignment.active_hub_mac;
                device.transport_mode = assignment.transport_mode;
            }
            await this.safeEvent({
                type: 'device.claimed',
                severity: 'info',
                run_id: run.id,
                account_id: input.accountId,
                mac: device.mac,
                message: `Claimed virtual device ${device.mac}`,
            });
        }

        if (device.desired_state === 'online' && this.runningTasks.has(run.id)) {
            const runtime = getRuntimeManager(this.logger).addDevice(
                run.id,
                device.mac,
                device.product_id,
                run.config.telemetry_interval * 1000,
                run.config.telemetry_jitter_percent ?? 10,
                run.config.startup_ramp_seconds ?? 30,
                device.seq || 0,
                device.state_snapshot,
                assignmentFromClaim(device),
            );
            await runtime.connect();
        }
    }

    private pickProduct(
        run: SimulationRun,
        userIndex: number,
        deviceIndex: number,
    ): { product_id: string; weight: number } {
        const totalWeight = run.config.products.reduce((sum, product) => sum + product.weight, 0);
        const seed = run.config.random_seed || run.id;
        let random = deterministicUnit(seed, `user:${userIndex}:device:${deviceIndex}:product`) * totalWeight;
        for (const product of run.config.products) {
            random -= product.weight;
            if (random <= 0) return product;
        }
        return run.config.products[run.config.products.length - 1];
    }

    private async createAvailableDeviceIdentity(
        seed: string,
        scope: string,
    ): Promise<Awaited<ReturnType<typeof createMockDeviceIdentity>>> {
        for (let attempt = 0; attempt < 20; attempt += 1) {
            const identity = await createMockDeviceIdentity(seed, `${scope}:attempt:${attempt}`);
            const [factoryRecord, registryRecord] = await Promise.all([
                getPgPool().query('SELECT 1 FROM factory_devices WHERE mac = $1', [identity.mac]),
                getMongoDb().collection('simulated_devices').findOne({ mac: identity.mac }),
            ]);
            if (factoryRecord.rows.length === 0 && !registryRecord) return identity;
        }
        throw new Error('Unable to allocate a collision-free virtual MAC address');
    }

    private async syncProgress(runId: string): Promise<void> {
        const db = getMongoDb();
        const [usersCreated, deviceProgress] = await Promise.all([
            db.collection<SimulatedUserRecord>('simulated_users').countDocuments({
                run_id: runId,
                account_id: { $type: 'string' },
            }),
            db.collection<SimulatedDeviceRecord>('simulated_devices').aggregate<{
                devices_requested: number;
                devices_provisioned: number;
                devices_claimed: number;
            }>([
                { $match: { run_id: runId } },
                {
                    $group: {
                        _id: null,
                        devices_requested: { $sum: 1 },
                        devices_provisioned: {
                            $sum: {
                                $cond: [{ $in: ['$provisioning_state', ['provisioned', 'claimed']] }, 1, 0],
                            },
                        },
                        devices_claimed: {
                            $sum: { $cond: [{ $eq: ['$provisioning_state', 'claimed'] }, 1, 0] },
                        },
                    },
                },
            ]).next(),
        ]);

        const requestedAggregation = await db.collection<SimulatedUserRecord>('simulated_users')
            .aggregate<{ total: number }>([
                { $match: { run_id: runId } },
                { $group: { _id: null, total: { $sum: '$target_device_count' } } },
            ]).next();

        await db.collection<SimulationRun>('simulation_runs').updateOne(
            { id: runId },
            {
                $set: {
                    'progress.users_created': usersCreated,
                    'progress.devices_requested': requestedAggregation?.total || 0,
                    'progress.devices_provisioned': deviceProgress?.devices_provisioned || 0,
                    'progress.devices_claimed': deviceProgress?.devices_claimed || 0,
                    updated_at: new Date(),
                },
            },
        );
    }

    private async updateRunStatus(
        runId: string,
        status: RunStatus,
        extraFields: Record<string, unknown> = {},
    ): Promise<void> {
        await getMongoDb().collection<SimulationRun>('simulation_runs').updateOne(
            { id: runId },
            { $set: { status, ...extraFields, updated_at: new Date() } },
        );
    }

    private async recordError(runId: string, errorMessage: string): Promise<void> {
        await getMongoDb().collection<SimulationRun>('simulation_runs').updateOne(
            { id: runId },
            {
                $inc: { total_errors: 1 },
                $set: { last_error: errorMessage.slice(0, 1000), updated_at: new Date() },
            },
        );
    }

    private async safeEvent(
        event: Parameters<typeof recordSimulatorEvent>[0],
    ): Promise<void> {
        try {
            await recordSimulatorEvent(event);
        } catch (error) {
            this.logger.warn({ err: error, type: event.type }, 'Failed to persist simulator event');
        }
    }
}

let queueInstance: GenerationQueue | null = null;

export const getGenerationQueue = (logger: FastifyBaseLogger): GenerationQueue => {
    if (!queueInstance) queueInstance = new GenerationQueue(logger);
    return queueInstance;
};
