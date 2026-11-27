import { z } from 'zod';
import { MOCK_SCENARIOS } from '../weather/forecast';
import { ACCOUNT_MOCK_HOURS } from '../weather/service';
import { PAYMENT_TABS } from './payments';
import { PERMISSION_CODES, type StaffPermission } from './permissions';

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
        staff_id: z.string().uuid().optional(),
        page,
        page_size: pageSize,
    }),
});

// ── Staff ─────────────────────────────────────────────────────────────────

const permissions = z.array(z.enum(PERMISSION_CODES as [StaffPermission, ...StaffPermission[]])).max(PERMISSION_CODES.length);
const staffParams = z.object({ id: z.string().uuid() });

export const staffLoginSchema = z.object({
    body: z.object({
        email: z.string().trim().min(3).max(320),
        password: z.string().min(1).max(128),
    }),
});

export const ownPasswordSchema = z.object({
    body: z.object({
        current_password: z.string().min(1).max(128),
        new_password: z.string().min(1).max(128),
    }),
});

export const createStaffSchema = z.object({
    body: z.object({
        email: z.string().trim().toLowerCase().email().max(320),
        full_name: z.string().trim().min(1).max(120),
        permissions,
    }),
});

export const updateStaffSchema = z.object({
    params: staffParams,
    body: z.object({
        full_name: z.string().trim().min(1).max(120).optional(),
        permissions: permissions.optional(),
    }),
});

export const staffActionSchema = z.object({
    params: staffParams.extend({ action: z.enum(['disable', 'enable', 'reset-password', 'sign-out']) }),
    body: z.object({ reason }),
});

// ── Mock weather ──────────────────────────────────────────────────────────

const weatherArea = z.string().regex(/^(all|[a-z][a-z_]{1,39})$/);
const mockFields = {
    scenario: z.enum(MOCK_SCENARIOS),
    temperature: z.number().finite().min(-10).max(50).optional(),
    rain_in_hours: z.number().int().min(1).max(12).optional(),
};

/** A province or everywhere (WEATHER_MODE=mock only). */
export const weatherMockSchema = z.object({
    body: z.object({ area: weatherArea, ...mockFields }).strict(),
});

/** One account, found by its email, for [hours] (default 2, at most 24). */
export const weatherAccountMockSchema = z.object({
    body: z.object({
        email: z.string().trim().toLowerCase().email().max(320),
        ...mockFields,
        hours: z.number().int().min(1).max(ACCOUNT_MOCK_HOURS.max).default(ACCOUNT_MOCK_HOURS.default),
    }).strict(),
});

export const weatherAccountParams = z.object({ params: accountParams });

export const weatherAreaSchema = z.object({
    params: z.object({ area: weatherArea }),
});

export const simulatorAuditSchema = z.object({
    body: z.object({
        method: z.enum(['POST', 'PATCH', 'PUT', 'DELETE']),
        path: z.string().regex(/^\/[A-Za-z0-9/_:.-]{1,200}$/),
        status: z.number().int().min(100).max(599),
    }),
});
