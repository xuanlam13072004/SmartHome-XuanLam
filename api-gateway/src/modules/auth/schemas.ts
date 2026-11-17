import { z } from 'zod';

export const registerSchema = z.object({
    body: z.object({
        email: z.string().trim().email().max(254),
        password: z.string().min(8).max(128),
        full_name: z.string().trim().min(1).max(120),
    }),
});

/** Shown in "Phiên đăng nhập", e.g. `{ platform: 'web', name: 'Chrome · Windows' }`. */
export const clientInfoSchema = z.object({
    platform: z.enum(['web', 'android', 'ios', 'windows', 'macos', 'linux', 'unknown']).default('unknown'),
    name: z.string().trim()
        .transform(value => value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80))
        .pipe(z.string().min(1))
        .optional(),
});

export const loginSchema = z.object({
    body: z.object({
        email: z.string().trim().email().max(254),
        password: z.string().min(8).max(128),
        client: clientInfoSchema.optional(),
    }),
});

export const refreshSchema = z.object({
    body: z.object({
        session_id: z.string().uuid(),
        refresh_token: z.string().min(20).max(256),
    }),
});

export const logoutSchema = z.object({
    body: z.object({
        session_id: z.string().uuid(),
        refresh_token: z.string().min(20).max(256),
    }),
});

export const reauthenticateSchema = z.object({
    body: z.object({
        password: z.string().min(8).max(128),
    }),
});
