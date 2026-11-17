import { z } from 'zod';

/** Icons the app knows how to draw; anything else would show as a blank tile. */
export const ROOM_ICONS = [
    'home', 'living', 'bedroom', 'kitchen', 'entrance', 'garden',
    'rooftop', 'garage', 'office', 'bathroom', 'kids', 'storage',
] as const;

const mac = z.string().trim().toUpperCase().regex(/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/, 'Invalid MAC address');
const roomName = z.string()
    .transform(value => value.replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim())
    .pipe(z.string().min(1).max(60));
const icon = z.enum(ROOM_ICONS);
const roomId = z.string().uuid();

export const createRoomSchema = z.object({
    body: z.object({ name: roomName, icon: icon.default('home') }).strict(),
});

export const updateRoomSchema = z.object({
    params: z.object({ roomId }),
    body: z.object({ name: roomName.optional(), icon: icon.optional() }).strict()
        .refine(body => body.name !== undefined || body.icon !== undefined, 'Nothing to change'),
});

export const roomParamsSchema = z.object({
    params: z.object({ roomId }),
});

export const reorderRoomsSchema = z.object({
    body: z.object({ room_ids: z.array(roomId).max(200) }).strict(),
});

export const deviceRoomSchema = z.object({
    params: z.object({ mac }),
    body: z.object({ room_id: roomId.nullable() }).strict(),
});

export const setupRoomsSchema = z.object({
    body: z.object({
        rooms: z.array(z.object({
            name: roomName,
            icon: icon.default('home'),
            devices: z.array(mac).max(200).default([]),
        }).strict()).min(1).max(30),
    }).strict(),
});
