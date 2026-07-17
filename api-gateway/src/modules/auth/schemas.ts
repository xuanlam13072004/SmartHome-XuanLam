import { z } from 'zod';

export const registerSchema = z.object({
    body: z.object({
        username: z.string().min(3).max(50),
        email: z.string().email(),
        password: z.string().min(8),
        full_name: z.string().min(1).max(100),
    }),
});

export const loginSchema = z.object({
    body: z.object({
        email: z.string().email(),
        password: z.string().min(8),
    }),
});

export const refreshSchema = z.object({
    body: z.object({
        session_id: z.string().uuid(),
        refresh_token: z.string().min(20),
    }),
});

export const logoutSchema = z.object({
    body: z.object({
        session_id: z.string().uuid(),
        refresh_token: z.string().min(20),
    }),
});
