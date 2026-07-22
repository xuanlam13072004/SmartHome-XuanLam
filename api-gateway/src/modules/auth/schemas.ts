import { z } from 'zod';

export const registerSchema = z.object({
    body: z.object({
        username: z.string().trim().min(3).max(50),
        email: z.string().trim().email().max(254),
        password: z.string().min(8).max(128),
        full_name: z.string().trim().min(1).max(100),
    }),
});

export const loginSchema = z.object({
    body: z.object({
        email: z.string().trim().email().max(254),
        password: z.string().min(8).max(128),
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
