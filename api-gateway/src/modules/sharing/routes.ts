import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { typedRouteConfig } from '../../plugins/validation';
import type { MemberRole } from './permissions';
import {
    deviceParamsSchema,
    inviteParamsSchema,
    inviteSchema,
    memberParamsSchema,
    myInviteParamsSchema,
    updateMemberSchema,
} from './schemas';
import {
    acceptInvite,
    cancelInvite,
    declineInvite,
    getSharingOverview,
    inviteMember,
    leaveDevice,
    listDeviceMembers,
    removeMember,
    updateMember,
} from './service';

const accountIdOf = (request: FastifyRequest) => (request.user as { userId: string }).userId;

/**
 * Device sharing. The owner invites by e-mail and manages members of a device;
 * the invitee accepts or declines in "Chia sẻ thiết bị"; a member may leave.
 */
const sharingRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
    const write = (max: number, timeWindow = '1 minute') => ({ max, timeWindow });

    // ── Owner ───────────────────────────────────────────────────────────────
    app.get('/devices/:mac/members', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({ zodSchema: deviceParamsSchema }),
    }, async (request) => {
        const { mac } = request.params as { mac: string };
        return { success: true, ...(await listDeviceMembers(app, accountIdOf(request), mac)) };
    });

    app.post('/devices/:mac/invites', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({ zodSchema: inviteSchema, rateLimit: write(30, '1 hour') }),
    }, async (request) => {
        const { mac } = request.params as { mac: string };
        const body = request.body as { email: string; role: MemberRole; permissions?: string[] };
        return { success: true, invite: await inviteMember(app, accountIdOf(request), mac, body) };
    });

    app.delete('/devices/:mac/invites/:inviteId', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({ zodSchema: inviteParamsSchema, rateLimit: write(30) }),
    }, async (request) => {
        const { mac, inviteId } = request.params as { mac: string; inviteId: string };
        await cancelInvite(app, accountIdOf(request), mac, inviteId);
        return { success: true };
    });

    app.patch('/devices/:mac/members/:accountId', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({ zodSchema: updateMemberSchema, rateLimit: write(30) }),
    }, async (request) => {
        const { mac, accountId } = request.params as { mac: string; accountId: string };
        await updateMember(app, accountIdOf(request), mac, accountId,
            request.body as { role: MemberRole; permissions?: string[] });
        return { success: true };
    });

    app.delete('/devices/:mac/members/:accountId', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({ zodSchema: memberParamsSchema, rateLimit: write(30) }),
    }, async (request) => {
        const { mac, accountId } = request.params as { mac: string; accountId: string };
        await removeMember(app, accountIdOf(request), mac, accountId);
        return { success: true };
    });

    // ── Member ──────────────────────────────────────────────────────────────
    app.delete('/devices/:mac/membership', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({ zodSchema: deviceParamsSchema, rateLimit: write(30) }),
    }, async (request) => {
        const { mac } = request.params as { mac: string };
        await leaveDevice(app, accountIdOf(request), mac);
        return { success: true };
    });

    app.get('/me/sharing', {
        preHandler: [app.authenticate],
    }, async (request) => ({ success: true, ...(await getSharingOverview(app, accountIdOf(request))) }));

    app.post('/me/invites/:inviteId/accept', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({ zodSchema: myInviteParamsSchema, rateLimit: write(30) }),
    }, async (request) => {
        const { inviteId } = request.params as { inviteId: string };
        return { success: true, ...(await acceptInvite(app, accountIdOf(request), inviteId)) };
    });

    app.post('/me/invites/:inviteId/decline', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({ zodSchema: myInviteParamsSchema, rateLimit: write(30) }),
    }, async (request) => {
        const { inviteId } = request.params as { inviteId: string };
        await declineInvite(app, accountIdOf(request), inviteId);
        return { success: true };
    });
};

export default sharingRoutes;
