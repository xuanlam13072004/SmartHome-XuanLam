import { z } from 'zod';

const macRegex = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;
const macSchema = z.string().trim().transform(value => value.toUpperCase()).pipe(
    z.string().regex(macRegex)
);
const networkFingerprintSchema = z.string()
    .trim()
    .transform(value => value.toLowerCase())
    .pipe(z.string().regex(/^[0-9a-f]{64}$/));

export const claimSchema = z.object({
    body: z.object({
        mac: macSchema,
        secret_key: z.string().min(8).max(128),
        name: z.string().min(1).max(120).optional(),
        network_fingerprint: networkFingerprintSchema.optional(),
    }),
});

export const unpairSchema = z.object({
    params: z.object({
        mac: macSchema,
    }),
});

export const operationSchema = z.object({
    params: z.object({
        mac: macSchema,
    }),
    body: z.object({
        instance_id: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
        operation_name: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
        input: z.record(z.unknown()).optional(),
        idempotency_key: z.string().min(1).max(128).optional(),
        expected_state_version: z.number().int().nonnegative().optional(),
    }),
});

export const resourceSessionSchema = z.object({
    params: z.object({
        mac: macSchema,
        instanceId: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
        resourceId: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
    }),
    body: z.object({}).strict(),
});

export const resourceSessionStatusSchema = z.object({
    params: z.object({
        mac: macSchema,
        sessionId: z.string().uuid(),
    }),
});

export const replaceCredentialSchema = z.object({
    params: z.object({
        mac: macSchema,
        instanceId: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
        credentialName: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
    }),
    body: z.object({
        material: z.string().min(1).max(4096),
        label: z.string().trim().min(1).max(120).optional(),
        idempotency_key: z.string().min(1).max(128).optional(),
    }),
});

export const credentialListSchema = z.object({
    params: z.object({ mac: macSchema }),
});

export const deviceStateSchema = z.object({
    params: z.object({
        mac: macSchema,
    }),
});

export const updateDeviceSchema = z.object({
    params: z.object({
        mac: macSchema,
    }),
    body: z.object({
        name: z.string().min(1).max(120),
    }),
});
