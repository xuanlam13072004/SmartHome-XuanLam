import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { env } from '../../config/env';
import { typedRouteConfig } from '../../plugins/validation';
import {
    createRoomSchema,
    deviceRoomSchema,
    reorderRoomsSchema,
    roomParamsSchema,
    setupRoomsSchema,
    updateRoomSchema,
} from './schemas';
import {
    createRoom,
    deleteRoom,
    listRooms,
    reorderRooms,
    setDeviceRoom,
    setupRooms,
    updateRoom,
} from './service';

const accountIdOf = (request: FastifyRequest) => (request.user as { userId: string }).userId;
const writes = { max: 60, timeWindow: '1 minute' };

/**
 * Rooms are personal: each account arranges the devices it can see. Light,
 * rarely-changing data, so no cache and no realtime fan-out; the app reloads
 * after its own edits. GET /devices returns each device's `room_id`.
 */
const roomRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
    app.get('/rooms', {
        preHandler: [app.authenticate],
    }, async (request) => ({
        success: true,
        rooms: await listRooms(app, accountIdOf(request)),
        limits: { max_rooms: env.MAX_ROOMS_PER_ACCOUNT },
    }));

    app.post('/rooms', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({ zodSchema: createRoomSchema, rateLimit: writes }),
    }, async (request) => ({
        success: true,
        room: await createRoom(app, accountIdOf(request), request.body as { name: string; icon: string }),
    }));

    app.post('/rooms/setup', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({ zodSchema: setupRoomsSchema, rateLimit: { max: 10, timeWindow: '1 minute' } }),
    }, async (request) => ({
        success: true,
        rooms: await setupRooms(
            app,
            accountIdOf(request),
            (request.body as { rooms: Array<{ name: string; icon: string; devices: string[] }> }).rooms,
        ),
    }));

    app.put('/rooms/order', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({ zodSchema: reorderRoomsSchema, rateLimit: writes }),
    }, async (request) => {
        await reorderRooms(app, accountIdOf(request), (request.body as { room_ids: string[] }).room_ids);
        return { success: true };
    });

    app.patch('/rooms/:roomId', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({ zodSchema: updateRoomSchema, rateLimit: writes }),
    }, async (request) => ({
        success: true,
        room: await updateRoom(
            app,
            accountIdOf(request),
            (request.params as { roomId: string }).roomId,
            request.body as { name?: string; icon?: string },
        ),
    }));

    app.delete('/rooms/:roomId', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({ zodSchema: roomParamsSchema, rateLimit: writes }),
    }, async (request) => {
        await deleteRoom(app, accountIdOf(request), (request.params as { roomId: string }).roomId);
        return { success: true };
    });

    app.put('/devices/:mac/room', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({ zodSchema: deviceRoomSchema, rateLimit: writes }),
    }, async (request) => ({
        success: true,
        ...(await setDeviceRoom(
            app,
            accountIdOf(request),
            (request.params as { mac: string }).mac,
            (request.body as { room_id: string | null }).room_id,
        )),
    }));
};

export default roomRoutes;
