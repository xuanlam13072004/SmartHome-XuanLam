import { z } from 'zod';

const mac = z.string().trim().toUpperCase().regex(/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/, 'Invalid MAC address');
const role = z.enum(['viewer', 'controller']);
const permissions = z.array(z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/)).max(20).optional();

export const deviceParamsSchema = z.object({
    params: z.object({ mac }),
});

export const inviteSchema = z.object({
    params: z.object({ mac }),
    body: z.object({
        email: z.string().trim().toLowerCase().email().max(254),
        role,
        permissions,
    }).strict(),
});

export const inviteParamsSchema = z.object({
    params: z.object({ mac, inviteId: z.string().uuid() }),
});

export const memberParamsSchema = z.object({
    params: z.object({ mac, accountId: z.string().uuid() }),
});

export const updateMemberSchema = z.object({
    params: z.object({ mac, accountId: z.string().uuid() }),
    body: z.object({ role, permissions }).strict(),
});

export const myInviteParamsSchema = z.object({
    params: z.object({ inviteId: z.string().uuid() }),
});
