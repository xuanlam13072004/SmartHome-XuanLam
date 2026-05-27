import { z } from 'zod';

const macRegex = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;

export const claimSchema = z.object({
    body: z.object({
        mac: z.string().regex(macRegex),
        secret_key: z.string().min(8).max(128),
        name: z.string().min(1).max(120).optional(),
    }),
});

export const unpairSchema = z.object({
    params: z.object({
        mac: z.string().regex(macRegex),
    }),
});

export const commandSchema = z.object({
    params: z.object({
        mac: z.string().regex(macRegex),
    }),
    body: z.object({
        action: z.enum(['ON', 'OFF', 'SET_TEMP']),
        payload: z.record(z.any()).optional(),
    }),
});

export const deviceStateSchema = z.object({
    params: z.object({
        mac: z.string().regex(macRegex),
    }),
});
