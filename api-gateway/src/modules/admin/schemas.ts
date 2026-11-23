import { z } from 'zod';
import { PAYMENT_TABS } from './payments';

const reason = z.string().trim().min(3).max(300);
const page = z.coerce.number().int().min(1).max(100000).default(1);
const pageSize = z.coerce.number().int().min(10).max(100).default(50);
const accountParams = z.object({ id: z.string().uuid() });
const orderParams = z.object({
    code: z.string().trim().transform(value => value.toUpperCase()).pipe(z.string().regex(/^SH[A-Z0-9]{8}$/)),
});

export const listAccountsSchema = z.object({
    query: z.object({
        q: z.string().trim().max(120).optional(),
        filter: z.enum(['all', 'disabled', 'paid']).default('all'),
        page,
        page_size: pageSize,
    }),
});

export const accountSchema = z.object({ params: accountParams });

export const accountActionSchema = z.object({
    params: accountParams,
    body: z.object({ reason }),
});

export const giftPlanSchema = z.object({
    params: accountParams,
    body: z.object({
        plan_code: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/),
        days: z.coerce.number().int().min(1).max(366),
        reason,
    }),
});

export const listPaymentsSchema = z.object({
    query: z.object({
        tab: z.enum(PAYMENT_TABS).default('review'),
        page,
        page_size: pageSize,
    }),
});

export const confirmPaymentSchema = z.object({
    params: orderParams,
    body: z.object({
        amount_vnd: z.coerce.number().int().min(1).max(1_000_000_000).optional(),
        reason,
    }),
});

export const cancelPaymentSchema = z.object({
    params: orderParams,
    body: z.object({ reason }),
});

export const auditSchema = z.object({
    query: z.object({
        action: z.string().regex(/^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/).optional(),
        account_id: z.string().uuid().optional(),
        page,
        page_size: pageSize,
    }),
});
