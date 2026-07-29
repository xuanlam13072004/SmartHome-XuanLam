import { z } from 'zod';

export const createRunBodySchema = z.object({
    user_count: z.number().int().min(1).max(10000),
    username_prefix: z.string().trim().min(1).max(24).regex(/^[a-zA-Z0-9_-]+$/).default('sim'),
    email_domain: z.string().trim().min(3).max(120).regex(/^[a-zA-Z0-9.-]+$/).default('simulator.local'),
    devices_min: z.number().int().min(0).max(100).default(1),
    devices_max: z.number().int().min(0).max(100).default(5),
    networks_min: z.number().int().min(1).max(100).default(1),
    networks_max: z.number().int().min(1).max(100).default(1),
    products: z.array(z.object({
        product_id: z.string().trim().min(1).max(64),
        weight: z.number().positive().max(10000),
    })).min(1).max(100),
    telemetry_interval: z.number().int().min(5).max(86400).default(15),
    telemetry_jitter_percent: z.number().min(0).max(50).default(10),
    startup_ramp_seconds: z.number().int().min(0).max(3600).default(30),
    random_seed: z.string().trim().min(1).max(128).optional(),
    initial_offline_rate: z.number().min(0).max(100).default(0),
    cleanup_policy: z.enum(['manual', 'auto_24h']).default('auto_24h'),
    auto_start: z.boolean().default(true),
}).superRefine((value, context) => {
    if (value.devices_min > value.devices_max) {
        context.addIssue({
            code: 'custom',
            path: ['devices_max'],
            message: 'devices_max must be greater than or equal to devices_min',
        });
    }
    if (value.networks_min > value.networks_max) {
        context.addIssue({
            code: 'custom',
            path: ['networks_max'],
            message: 'networks_max must be greater than or equal to networks_min',
        });
    }
    if (value.devices_max > 0 && value.networks_min > value.devices_max) {
        context.addIssue({
            code: 'custom',
            path: ['networks_min'],
            message: 'networks_min cannot exceed devices_max',
        });
    }

    const productIds = value.products.map((product) => product.product_id);
    if (new Set(productIds).size !== productIds.length) {
        context.addIssue({
            code: 'custom',
            path: ['products'],
            message: 'product_id values must be unique',
        });
    }
});

export const extendRunBodySchema = z.object({
    hours: z.number().int().min(1).max(24 * 30),
});

export const retentionBodySchema = z.object({
    policy: z.enum(['auto_24h', 'permanent']),
});
