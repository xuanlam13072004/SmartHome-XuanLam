import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env';
import type {
    SimulatedDeviceRecord,
    SimulatedUserRecord,
} from '../../domain/registry';
import { getMongoDb } from '../../infrastructure/mongodb/client';
import { decrypt } from '../../security/crypto';
import { recordSimulatorEvent } from '../../events/service';

const userProjection = {
    credential: 0,
} as const;

const usersRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
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
            .find(
                { simulator_user_id: accountId },
                { projection: { secret: 0 } },
            )
            .sort({ generation_index: 1 })
            .toArray();
        return { success: true, user, devices };
    });

    app.post('/api/users/:accountId/reveal-credential', async (request, reply) => {
        const { accountId } = request.params as { accountId: string };
        const user = await getMongoDb().collection<SimulatedUserRecord>('simulated_users')
            .findOne({ account_id: accountId });
        if (!user) return reply.status(404).send({ success: false, error: 'User not found' });

        const password = decrypt(
            user.credential.iv,
            user.credential.encrypted,
            user.credential.authTag,
        );
        await recordSimulatorEvent({
            type: 'security.credential_revealed',
            severity: 'warning',
            run_id: user.run_id,
            account_id: accountId,
            message: `Login credential was revealed for ${user.email}`,
        });
        reply.header('Cache-Control', 'no-store');
        return {
            success: true,
            credential: {
                email: user.email,
                username: user.username,
                password,
            },
        };
    });
};

export default usersRoutes;
