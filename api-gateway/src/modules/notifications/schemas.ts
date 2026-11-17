import { z } from 'zod';
import { MUTABLE_NOTIFICATION_CATEGORIES } from '../../../../shared/notification-categories';

export const pageQuerySchema = z.object({
    query: z.object({
        before: z.string().max(300).optional(),
        limit: z.coerce.number().int().min(1).max(50).default(30),
    }),
});

export const preferencesSchema = z.object({
    body: z.object({
        // "safety" is not in the list: fire and gas alerts cannot be muted.
        muted_notification_categories: z.array(z.enum(MUTABLE_NOTIFICATION_CATEGORIES as unknown as [string, ...string[]])).max(10),
    }).strict(),
});
