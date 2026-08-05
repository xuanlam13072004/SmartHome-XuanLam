import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env';
import type {
    SimulatedDeviceRecord,
    SimulatedUserRecord,
} from '../../domain/registry';
import type { SimulationRun } from '../../domain/simulation-run';
import { getMainMongoDb, getMongoDb } from '../../infrastructure/mongodb/client';
import { getPgPool } from '../../infrastructure/postgres/client';
import { apiGateway } from '../../infrastructure/api-gateway/client';
import { decrypt } from '../../security/crypto';
import {
    decryptRefreshToken,
    encryptAuthSession,
} from '../../security/auth-session';
import { recordSimulatorEvent } from '../../events/service';
import type { CleanupCronjob } from '../../cleanup/cronjob';

const userProjection = {
    credential: 0,
    'auth_session.access_token': 0,
    'auth_session.refresh_token': 0,
} as const;
const deviceProjection = { secret: 0 } as const;
const extendSchema = z.object({
    hours: z.coerce.number().int().min(1).max(720),
}).strict();

export const createUsersRoutes = (cleanupJob: CleanupCronjob): FastifyPluginAsync =>
    async (app: FastifyInstance) => {
        app.get('/api/users', async (request) => {
            const query = request.query as { run_id?: string; limit?: string };
            const filter = query.run_id ? { run_id: query.run_id } : {};
            const limit = Math.min(Math.max(Number(query.limit) || 100, 1), env.MAX_PAGE_SIZE);
            const users = await getMongoDb().collection<SimulatedUserRecord>('simulated_users')
                .find(filter, { projection: userProjection })
                .sort({ created_at: -1 })
                .limit(limit)
                .toArray();
            return { success: true, users };
        });

        app.get('/api/users/:accountId', async (request, reply) => {
            const { accountId } = request.params as { accountId: string };
            const user = await getMongoDb().collection<SimulatedUserRecord>('simulated_users')
                .findOne({ account_id: accountId }, { projection: userProjection });
            if (!user) {
                return reply.status(404).send({
                    success: false,
                    error: { code: 'USER_NOT_FOUND', message: 'Simulated user not found' },
                });
            }
            const devices = await getMongoDb().collection<SimulatedDeviceRecord>('simulated_devices')
                .find({ simulator_user_id: accountId }, { projection: deviceProjection })
                .sort({ generation_index: 1 })
                .toArray();
            const macs = devices.map((device) => device.mac);
            const [telemetry, operations] = await Promise.all([
                macs.length === 0
                    ? []
                    : getMainMongoDb().collection(env.MAIN_MONGO_TELEMETRY_COLLECTION)
                        .find({ 'metadata.device_id': { $in: macs } })
                        .sort({ observed_at: -1 })
                        .limit(100)
                        .toArray(),
                getPgPool().query(
                    `SELECT operation.id::text, device.mac, operation.status,
                            operation.instance_id, operation.operation_name,
                            operation.input, operation.risk, operation.reason_code,
                            operation.catalog_revision, operation.accepted_at,
                            operation.completed_at, operation.created_at,
                            operation.updated_at
                     FROM device_operations AS operation
                     JOIN device_metadata AS device ON device.id = operation.device_id
                     WHERE operation.actor_account_id = $1
                     ORDER BY operation.created_at DESC
                     LIMIT 100`,
                    [accountId],
                ).then((result) => result.rows),
            ]);
            return { success: true, user, devices, telemetry, operations };
        });

        app.post('/api/users/:accountId/relogin', async (request, reply) => {
            const user = await requireUser(request, reply);
            if (!user) return;
            const password = decrypt(
                user.credential.iv,
                user.credential.encrypted,
                user.credential.authTag,
            );
            const session = await apiGateway.login({ email: user.email, password });
            const encryptedSession = encryptAuthSession(session);
            await getMongoDb().collection<SimulatedUserRecord>('simulated_users').updateOne(
                { account_id: user.account_id },
                { $set: { auth_session: encryptedSession, updated_at: new Date() } },
            );
            await recordUserAction(user, 'user.relogin', 'Simulator user logged in again');
            return {
                success: true,
                session: {
                    session_id: encryptedSession.session_id,
                    updated_at: encryptedSession.updated_at,
                },
            };
        });

        app.post('/api/users/:accountId/refresh-session', async (request, reply) => {
            const user = await requireUser(request, reply);
            if (!user) return;
            if (!user.auth_session) {
                return reply.status(409).send({
                    success: false,
                    error: 'No stored login session is available; use relogin first',
                });
            }
            const session = await apiGateway.refreshSession({
                sessionId: user.auth_session.session_id,
                refreshToken: decryptRefreshToken(user.auth_session),
            });
            const encryptedSession = encryptAuthSession(session);
            await getMongoDb().collection<SimulatedUserRecord>('simulated_users').updateOne(
                { account_id: user.account_id },
                { $set: { auth_session: encryptedSession, updated_at: new Date() } },
            );
            await recordUserAction(user, 'user.session_refreshed', 'Simulator user session refreshed');
            return {
                success: true,
                session: {
                    session_id: encryptedSession.session_id,
                    updated_at: encryptedSession.updated_at,
                },
            };
        });

        app.post('/api/users/:accountId/extend', async (request, reply) => {
            const parsed = extendSchema.safeParse(request.body);
            if (!parsed.success) {
                return reply.status(400).send({ success: false, error: parsed.error.flatten() });
            }
            const user = await requireUser(request, reply);
            if (!user) return;
            const base = user.expires_at && user.expires_at > new Date()
                ? user.expires_at
                : new Date();
            const expiresAt = new Date(base.getTime() + parsed.data.hours * 60 * 60 * 1000);
            const run = await getMongoDb().collection<SimulationRun>('simulation_runs')
                .findOne({ id: user.run_id });
            const cleanupAfter = run?.cleanup_after && run.cleanup_after > expiresAt
                ? run.cleanup_after
                : expiresAt;
            await Promise.all([
                getMongoDb().collection<SimulatedUserRecord>('simulated_users').updateOne(
                    { account_id: user.account_id },
                    {
                        $set: {
                            retention_policy: 'ttl',
                            expires_at: expiresAt,
                            updated_at: new Date(),
                        },
                    },
                ),
                getMongoDb().collection<SimulatedDeviceRecord>('simulated_devices').updateMany(
                    { simulator_user_id: user.account_id },
                    {
                        $set: {
                            retention_policy: 'ttl',
                            expires_at: expiresAt,
                            updated_at: new Date(),
                        },
                    },
                ),
                getMongoDb().collection<SimulationRun>('simulation_runs').updateOne(
                    { id: user.run_id },
                    {
                        $set: {
                            'config.cleanup_policy': 'auto_24h',
                            cleanup_after: cleanupAfter,
                            updated_at: new Date(),
                        },
                    },
                ),
            ]);
            await recordUserAction(
                user,
                'user.retention_extended',
                'Simulator user retention was extended',
                { hours: parsed.data.hours, expires_at: expiresAt },
            );
            return { success: true, retention_policy: 'ttl', expires_at: expiresAt };
        });

        app.post('/api/users/:accountId/make-permanent', async (request, reply) => {
            const user = await requireUser(request, reply);
            if (!user) return;
            const now = new Date();
            const update = {
                $set: { retention_policy: 'permanent' as const, updated_at: now },
                $unset: { expires_at: '' as const },
            };
            await Promise.all([
                getMongoDb().collection<SimulatedUserRecord>('simulated_users')
                    .updateOne({ account_id: user.account_id }, update),
                getMongoDb().collection<SimulatedDeviceRecord>('simulated_devices')
                    .updateMany({ simulator_user_id: user.account_id }, update),
            ]);
            await recordUserAction(
                user,
                'user.made_permanent',
                'Simulator user and tracked devices were made permanent',
            );
            return { success: true, retention_policy: 'permanent' };
        });

        app.post('/api/users/:accountId/cleanup', async (request, reply) => {
            const { accountId } = request.params as { accountId: string };
            const result = await cleanupJob.cleanupUser(accountId);
            return reply.status(result.status === 'cleanup_blocked' ? 409 : 200).send({
                success: result.status === 'cleaned',
                ...result,
            });
        });

        app.post('/api/users/:accountId/reveal-credential', async (request, reply) => {
            const user = await requireUser(request, reply);
            if (!user) return;
            const password = decrypt(
                user.credential.iv,
                user.credential.encrypted,
                user.credential.authTag,
            );
            await recordUserAction(
                user,
                'security.credential_revealed',
                `Login credential was revealed for ${user.email}`,
            );
            reply.header('Cache-Control', 'no-store');
            return {
                success: true,
                credential: { email: user.email, password },
            };
        });
    };

const requireUser = async (
    request: { params: unknown },
    reply: { status: (code: number) => { send: (body: unknown) => unknown } },
): Promise<SimulatedUserRecord | null> => {
    const { accountId } = request.params as { accountId: string };
    const user = await getMongoDb().collection<SimulatedUserRecord>('simulated_users')
        .findOne({ account_id: accountId });
    if (!user) {
        reply.status(404).send({ success: false, error: 'User not found' });
        return null;
    }
    return user;
};

const recordUserAction = async (
    user: SimulatedUserRecord,
    type: string,
    message: string,
    data?: Record<string, unknown>,
): Promise<void> => {
    await recordSimulatorEvent({
        type,
        severity: type.startsWith('security.') ? 'warning' : 'info',
        run_id: user.run_id,
        account_id: user.account_id,
        message,
        ...(data ? { data } : {}),
    });
};

export default createUsersRoutes;
