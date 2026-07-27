import crypto from 'node:crypto';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import {
    createRunBodySchema,
    extendRunBodySchema,
    retentionBodySchema,
} from '../schemas/runs';
import { getMongoDb } from '../../infrastructure/mongodb/client';
import type { RunStatus, SimulationRun } from '../../domain/simulation-run';
import { getGenerationQueue } from '../../generation/queue';
import { getCachedCatalog } from '../../catalog/loader';
import type { CleanupCronjob } from '../../cleanup/cronjob';
import { env } from '../../config/env';
import { recordSimulatorEvent } from '../../events/service';
import {
    emptyMetricTotals,
    getRunMetricsService,
} from '../../metrics/service';
import { getRuntimeManager } from '../../runtime/manager';
import { evaluateWorkloadBudget } from '../../workload/budget';
import { restoreRunDevices } from '../../runtime/restore-run';

const terminalStatuses = new Set([
    'completed',
    'partial',
    'failed',
    'cancelled',
    'cleaned',
    'cleanup_failed',
    'cleanup_blocked',
]);

export const createRunsRoutes = (cleanupJob: CleanupCronjob): FastifyPluginAsync =>
    async (app: FastifyInstance) => {
        const generationQueue = getGenerationQueue(app.log);

        app.post('/api/simulation-runs', async (request, reply) => {
            const parsed = createRunBodySchema.safeParse(request.body);
            if (!parsed.success) {
                return reply.status(400).send({
                    success: false,
                    error: {
                        code: 'INVALID_RUN_CONFIG',
                        message: 'Simulation run configuration is invalid',
                        details: parsed.error.flatten(),
                    },
                });
            }

            const config = parsed.data;
            const catalogIds = new Set(getCachedCatalog().map((product) => product.id));
            const unknownProducts = config.products
                .map((product) => product.product_id)
                .filter((productId) => !catalogIds.has(productId));
            if (unknownProducts.length > 0) {
                return reply.status(400).send({
                    success: false,
                    error: {
                        code: 'UNKNOWN_PRODUCTS',
                        message: `Unknown product IDs: ${unknownProducts.join(', ')}`,
                    },
                });
            }

            const workloadBudget = evaluateWorkloadBudget(config, {
                maxUsersPerRun: env.MAX_USERS_PER_RUN,
                maxDevicesPerRun: env.MAX_DEVICES_PER_RUN,
                maxActiveDevices: env.MAX_ACTIVE_DEVICES,
                maxTelemetryMessagesPerSecond: env.MAX_TELEMETRY_MESSAGES_PER_SECOND,
            });
            if (!workloadBudget.accepted) {
                return reply.status(400).send({
                    success: false,
                    error: {
                        code: 'WORKLOAD_LIMIT_EXCEEDED',
                        message: 'Simulation workload exceeds configured safety limits',
                        details: {
                            estimate: workloadBudget.estimate,
                            violations: workloadBudget.violations,
                        },
                    },
                });
            }

            const runId = `run-${crypto.randomUUID()}`;
            const now = new Date();
            const newRun: SimulationRun = {
                id: runId,
                status: 'queued',
                config,
                progress: {
                    users_requested: config.user_count,
                    users_created: 0,
                    devices_requested: 0,
                    devices_provisioned: 0,
                    devices_claimed: 0,
                },
                metrics: {
                    totals: emptyMetricTotals(),
                },
                total_errors: 0,
                cleanup_retries: 0,
                created_at: now,
                updated_at: now,
            };

            await getMongoDb().collection<SimulationRun>('simulation_runs').insertOne(newRun);
            await recordSimulatorEvent({
                type: 'run.queued',
                severity: 'info',
                run_id: runId,
                message: 'Simulation run queued',
                data: {
                    user_count: config.user_count,
                    devices_min: config.devices_min,
                    devices_max: config.devices_max,
                    workload_estimate: workloadBudget.estimate,
                },
            });
            void generationQueue.startRun(newRun).catch((error) => {
                app.log.error({ err: error, runId }, 'Unhandled generation queue error');
            });

            return reply.status(202).send({ success: true, run_id: runId, status: 'queued' });
        });

        app.get('/api/simulation-runs', async (request) => {
            const query = request.query as { limit?: string; status?: string };
            const limit = Math.min(Math.max(Number(query.limit) || 100, 1), env.MAX_PAGE_SIZE);
            const filter = query.status ? { status: query.status as RunStatus } : {};
            const runs = await getMongoDb().collection<SimulationRun>('simulation_runs')
                .find(filter)
                .sort({ created_at: -1 })
                .limit(limit)
                .toArray();
            return { success: true, runs };
        });

        app.get('/api/simulation-runs/:id', async (request, reply) => {
            const { id } = request.params as { id: string };
            const run = await getMongoDb().collection<SimulationRun>('simulation_runs').findOne({ id });
            if (!run) {
                return reply.status(404).send({
                    success: false,
                    error: { code: 'RUN_NOT_FOUND', message: 'Simulation run not found' },
                });
            }
            return { success: true, run };
        });

        app.get('/api/simulation-runs/:id/metrics', async (request, reply) => {
            const { id } = request.params as { id: string };
            const snapshot = await getRunMetricsService(app.log).snapshot(
                id,
                getRuntimeManager(app.log).getStats(id),
            );
            if (!snapshot) {
                return reply.status(404).send({
                    success: false,
                    error: { code: 'RUN_NOT_FOUND', message: 'Simulation run not found' },
                });
            }
            return { success: true, metrics: snapshot };
        });

        app.post('/api/simulation-runs/:id/pause', async (request, reply) => {
            const { id } = request.params as { id: string };
            const run = await getMongoDb().collection<SimulationRun>('simulation_runs').findOne({ id });
            if (!run) return reply.status(404).send({ success: false, error: 'Run not found' });
            if (terminalStatuses.has(run.status)) {
                return reply.status(409).send({ success: false, error: 'Terminal run cannot be paused' });
            }
            generationQueue.stopRun(id);
            await getRuntimeManager(app.log).pauseRun(id);
            const pausedAt = new Date();
            await Promise.all([
                getMongoDb().collection('simulation_runs').updateOne(
                    { id },
                    { $set: { status: 'paused', updated_at: pausedAt } },
                ),
                getMongoDb().collection('simulated_devices').updateMany(
                    {
                        run_id: id,
                        provisioning_state: 'claimed',
                        desired_state: 'online',
                    },
                    { $set: { runtime_state: 'paused', updated_at: pausedAt } },
                ),
            ]);
            await recordSimulatorEvent({
                type: 'run.paused',
                severity: 'info',
                run_id: id,
                message: 'Simulation generation and active device runtimes paused',
            });
            return { success: true, status: 'paused' };
        });

        app.post('/api/simulation-runs/:id/resume', async (request, reply) => {
            const { id } = request.params as { id: string };
            const run = await getMongoDb().collection<SimulationRun>('simulation_runs').findOne({ id });
            if (!run) return reply.status(404).send({ success: false, error: 'Run not found' });
            if (run.status !== 'paused' && run.status !== 'failed') {
                return reply.status(409).send({ success: false, error: 'Only paused or failed runs can resume' });
            }
            const resumedRun: SimulationRun = { ...run, status: 'queued' };
            await getMongoDb().collection('simulation_runs').updateOne(
                { id },
                { $set: { status: 'queued', updated_at: new Date() } },
            );
            const runtimeRecovery = await restoreRunDevices(resumedRun, app.log);
            void generationQueue.startRun(resumedRun);
            await recordSimulatorEvent({
                type: 'run.resumed',
                severity: runtimeRecovery.failed > 0 ? 'warning' : 'info',
                run_id: id,
                message: 'Simulation generation and device runtimes resumed',
                data: { runtime_recovery: runtimeRecovery },
            });
            return reply.status(202).send({
                success: true,
                status: 'queued',
                runtime_recovery: runtimeRecovery,
            });
        });

        app.post('/api/simulation-runs/:id/cancel', async (request, reply) => {
            const { id } = request.params as { id: string };
            const run = await getMongoDb().collection<SimulationRun>('simulation_runs').findOne({ id });
            if (!run) return reply.status(404).send({ success: false, error: 'Run not found' });
            if (terminalStatuses.has(run.status)) {
                return reply.status(409).send({ success: false, error: 'Run is already terminal' });
            }
            generationQueue.stopRun(id);
            const completedAt = new Date();
            const cleanupAfter = run.config.cleanup_policy === 'auto_24h'
                ? new Date(completedAt.getTime() + env.CLEANUP_RETENTION_HOURS * 60 * 60 * 1000)
                : undefined;
            await getMongoDb().collection('simulation_runs').updateOne(
                { id },
                {
                    $set: {
                        status: 'cancelled',
                        completed_at: completedAt,
                        cleanup_after: cleanupAfter,
                        updated_at: completedAt,
                    },
                },
            );
            return { success: true, status: 'cancelled', cleanup_after: cleanupAfter };
        });

        app.post('/api/simulation-runs/:id/cleanup', async (request, reply) => {
            const { id } = request.params as { id: string };
            const result = await cleanupJob.cleanupRun(id);
            return reply.status(result.status === 'cleanup_blocked' ? 409 : 200).send({
                success: result.status === 'cleaned',
                ...result,
            });
        });

        app.post('/api/simulation-runs/:id/extend', async (request, reply) => {
            const { id } = request.params as { id: string };
            const parsed = extendRunBodySchema.safeParse(request.body);
            if (!parsed.success) return reply.status(400).send({ success: false, error: parsed.error.flatten() });
            const run = await getMongoDb().collection<SimulationRun>('simulation_runs').findOne({ id });
            if (!run) return reply.status(404).send({ success: false, error: 'Run not found' });
            if (!run.completed_at || run.status === 'cleaned') {
                return reply.status(409).send({ success: false, error: 'Only completed, retained runs can be extended' });
            }
            const base = run.cleanup_after && run.cleanup_after > new Date() ? run.cleanup_after : new Date();
            const cleanupAfter = new Date(base.getTime() + parsed.data.hours * 60 * 60 * 1000);
            await Promise.all([
                getMongoDb().collection('simulation_runs').updateOne(
                    { id },
                    {
                        $set: {
                            'config.cleanup_policy': 'auto_24h',
                            cleanup_after: cleanupAfter,
                            updated_at: new Date(),
                        },
                    },
                ),
                getMongoDb().collection('simulated_users').updateMany(
                    { run_id: id },
                    { $set: { retention_policy: 'ttl', expires_at: cleanupAfter } },
                ),
                getMongoDb().collection('simulated_devices').updateMany(
                    { run_id: id },
                    { $set: { retention_policy: 'ttl', expires_at: cleanupAfter } },
                ),
            ]);
            return { success: true, cleanup_after: cleanupAfter };
        });

        app.post('/api/simulation-runs/:id/retention', async (request, reply) => {
            const { id } = request.params as { id: string };
            const parsed = retentionBodySchema.safeParse(request.body);
            if (!parsed.success) return reply.status(400).send({ success: false, error: parsed.error.flatten() });
            const run = await getMongoDb().collection<SimulationRun>('simulation_runs').findOne({ id });
            if (!run) return reply.status(404).send({ success: false, error: 'Run not found' });

            const permanent = parsed.data.policy === 'permanent';
            const cleanupAfter = permanent
                ? undefined
                : new Date(Date.now() + env.CLEANUP_RETENTION_HOURS * 60 * 60 * 1000);
            const recordUpdate = permanent
                ? { $set: { retention_policy: 'permanent', updated_at: new Date() }, $unset: { expires_at: '' } }
                : { $set: { retention_policy: 'ttl', expires_at: cleanupAfter, updated_at: new Date() } };
            const runUpdate = permanent
                ? {
                    $set: { 'config.cleanup_policy': 'manual', updated_at: new Date() },
                    $unset: { cleanup_after: '' },
                }
                : {
                    $set: {
                        'config.cleanup_policy': 'auto_24h',
                        cleanup_after: cleanupAfter,
                        updated_at: new Date(),
                    },
                };
            await Promise.all([
                getMongoDb().collection('simulation_runs').updateOne({ id }, runUpdate),
                getMongoDb().collection('simulated_users').updateMany({ run_id: id }, recordUpdate),
                getMongoDb().collection('simulated_devices').updateMany({ run_id: id }, recordUpdate),
            ]);
            return {
                success: true,
                retention_policy: permanent ? 'permanent' : 'ttl',
                cleanup_after: cleanupAfter,
            };
        });
    };

export default createRunsRoutes;
