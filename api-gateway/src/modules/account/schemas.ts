import { z } from 'zod';

/** Display name: trimmed, no control characters, 1–120 characters. */
export const fullNameSchema = z.string()
    .transform(value => value.replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim())
    .pipe(z.string().min(1).max(120));

export const updateProfileSchema = z.object({
    body: z.object({
        full_name: fullNameSchema,
    }).strict(),
});

export const changePasswordSchema = z.object({
    body: z.object({
        current_password: z.string().min(1).max(128),
        new_password: z.string().min(8).max(128),
    }).strict(),
});

export const sessionParamsSchema = z.object({
    params: z.object({
        sessionId: z.string().uuid(),
    }),
});

export const deleteAccountSchema = z.object({
    body: z.object({
        password: z.string().min(1).max(128),
    }).strict(),
});
