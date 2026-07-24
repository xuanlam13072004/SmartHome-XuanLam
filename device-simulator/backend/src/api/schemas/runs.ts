import { z } from 'zod';

export const createRunSchema = z.object({
    body: z.object({
        user_count: z.number().min(1).max(10000),
        username_prefix: z.string().min(1).default('sim'),
        email_domain: z.string().min(3).default('simulator.local'),
        devices_min: z.number().min(0).default(1),
        devices_max: z.number().min(0).default(5),
        products: z.array(z.object({
            product_id: z.string(),
            weight: z.number().min(1).max(100)
        })).min(1),
        telemetry_interval: z.number().min(5).default(15),
        random_seed: z.string().optional(),
        concurrency: z.number().min(1).max(50).default(5),
        initial_offline_rate: z.number().min(0).max(100).default(0),
        cleanup_policy: z.enum(['manual', 'auto_24h']).default('auto_24h'),
        auto_start: z.boolean().default(true)
    })
});
