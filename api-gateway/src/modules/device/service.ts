import argon2 from 'argon2';
import crypto from 'crypto';
import { FastifyInstance } from 'fastify';
import { env } from '../../config/env';
// @ts-ignore - shared CommonJS module
import { validateObjectAgainstSchema } from '../../../../shared/validation';
// @ts-ignore - shared CommonJS module
import { CACHE_PREFIXES, REDIS_CHANNELS } from '../../../../shared/constants';
import { dispatchDeviceShadowOutboxEvent } from '../../workers/deviceShadowOutboxDispatcher';
import { dispatchTopologyOutboxEvent } from '../../workers/topologyOutboxDispatcher';
import {
    claimTopologyMembership,
    removeTopologyMembership,
    resolveNetworkFingerprint,
} from './topologyRepository';

function buildError(message: string, statusCode: number, code: string) {
    const error = new Error(message) as any;
    error.statusCode = statusCode;
    error.code = code;
    return error;
}

function normalizeMac(mac: string) {
    return mac.trim().toUpperCase();
}

async function invalidateDeviceContext(app: FastifyInstance, mac: string) {
    try {
        await app.redis.del(
            `${CACHE_PREFIXES.OWNER_OF}${mac}`,
            `${CACHE_PREFIXES.PRODUCT_OF}${mac}`,
            `${CACHE_PREFIXES.CATALOG_REVISION_OF}${mac}`,
        );
        await app.redis.publish(REDIS_CHANNELS.DEVICE_CONTEXT_INVALIDATED, mac);
    } catch (error) {
        app.log.warn({ error, mac }, 'Failed to invalidate cached device context');
    }
}

export async function claimDevice(app: FastifyInstance, input: {
    mac: string;
    secret_key: string;
    name?: string;
    network_fingerprint?: string;
}, ownerId: string) {
    const mac = normalizeMac(input.mac);
    const client = await app.pg.connect();
    let shadowOutboxId = 0;
    let topologyOutboxId = 0;
    let result: any;

    try {
        await client.query('BEGIN');
        const factoryResult = await client.query(
            `SELECT mac, secret_key_hash, product_id, catalog_revision,
                    firmware_family, is_claimed
             FROM factory_devices
             WHERE mac = $1
             FOR UPDATE`,
            [mac],
        );
        const factory = factoryResult.rows[0];
        if (!factory) throw buildError('Device not authentic', 404, 'DEVICE_NOT_AUTHENTIC');
        if (factory.is_claimed) throw buildError('Device already claimed', 409, 'DEVICE_ALREADY_CLAIMED');

        const product = app.catalog.getProduct(factory.product_id);
        if (!product || product.catalog_revision !== factory.catalog_revision) {
            throw buildError(
                'Device product revision is not published in the runtime catalog',
                400,
                'INVALID_DEVICE_PRODUCT_REVISION',
            );
        }
        if (!(await argon2.verify(factory.secret_key_hash, input.secret_key))) {
            throw buildError('Device not authentic', 401, 'INVALID_DEVICE_SECRET');
        }

        const claim = await client.query(
            `UPDATE factory_devices
             SET is_claimed = true, claimed_at = NOW()
             WHERE mac = $1 AND is_claimed = false
             RETURNING mac`,
            [mac],
        );
        if (claim.rows.length !== 1) {
            throw buildError('Device already claimed', 409, 'DEVICE_ALREADY_CLAIMED');
        }

        const name = input.name?.trim()
            || `${product.presentation?.display_name || product.model_name} ${mac.slice(-5)}`;
        const topologyResult = await claimTopologyMembership(client, {
            ownerId,
            mac,
            name,
            productId: factory.product_id,
            catalogRevision: factory.catalog_revision,
            networkFingerprint: resolveNetworkFingerprint(input.network_fingerprint, mac),
        });
        topologyOutboxId = topologyResult.topologyOutboxId;
        const assigned = topologyResult.topology.members.find(
            member => member.device_id === topologyResult.device.id,
        );
        result = {
            ...topologyResult.device,
            topology_role: assigned?.role ?? 'node',
            topology_epoch: topologyResult.topology.topology_epoch,
            topology_state: topologyResult.topology.topology_state,
            active_hub_device_id: topologyResult.topology.active_hub_device_id,
            active_hub_mac: topologyResult.topology.active_hub_mac,
        };

        const outbox = await client.query(
            `INSERT INTO device_shadow_outbox (device_id, mac, operation, payload)
             VALUES ($1, $2, 'claim', $3::jsonb)
             RETURNING id`,
            [
                topologyResult.device.id,
                mac,
                JSON.stringify({
                    owner_id: ownerId,
                    product_id: factory.product_id,
                    catalog_revision: factory.catalog_revision,
                    name,
                    access_account_ids: [ownerId],
                    // Include full catalog permissions snapshot for the owner.
                    // Stored in MongoDB shadow so Real-Time Service can read without Postgres.
                    owner_permissions: product.permissions || [],
                    access_grants: [{
                        account_id: ownerId,
                        role: 'owner',
                        permissions: product.permissions || [],
                    }],
                }),
            ],
        );
        shadowOutboxId = Number(outbox.rows[0].id);
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }

    await dispatchDeviceShadowOutboxEvent(app.pg, app.mongo.db, app.log, shadowOutboxId)
        .catch(error => app.log.warn({ error, mac }, 'Shadow claim event queued for retry'));
    await dispatchTopologyOutboxEvent(
        app.pg,
        app.redis,
        app.mongo.db,
        app.log,
        topologyOutboxId,
    ).catch(error => app.log.warn({ error, mac }, 'Topology claim event queued for retry'));
    await invalidateDeviceContext(app, mac);
    try {
        await app.redis.setex(
            `${CACHE_PREFIXES.OWNER_OF}${mac}`,
            env.REDIS_CACHE_TTL_SECONDS,
            ownerId,
        );
    } catch (error) {
        app.log.warn({ error, mac }, 'Failed to cache device ownership');
    }
    return result;
}

export async function unpairDevice(app: FastifyInstance, macInput: string, ownerId: string) {
    const mac = normalizeMac(macInput);
    const client = await app.pg.connect();
    let shadowOutboxId = 0;
    let removalResult: Awaited<ReturnType<typeof removeTopologyMembership>>;

    try {
        await client.query('BEGIN');
        removalResult = await removeTopologyMembership(client, ownerId, mac);
        if (!removalResult) throw buildError('Device not found', 404, 'DEVICE_NOT_FOUND');

        const released = await client.query(
            `UPDATE factory_devices
             SET is_claimed = false, claimed_at = NULL
             WHERE mac = $1 AND is_claimed = true
             RETURNING mac`,
            [mac],
        );
        if (released.rows.length !== 1) {
            throw buildError('Factory device state is inconsistent', 500, 'FACTORY_DEVICE_INCONSISTENT');
        }
        const outbox = await client.query(
            `INSERT INTO device_shadow_outbox (device_id, mac, operation, payload)
             VALUES ($1, $2, 'unpair', $3::jsonb)
             RETURNING id`,
            [removalResult.device.id, mac, JSON.stringify({ previous_owner_id: ownerId })],
        );
        shadowOutboxId = Number(outbox.rows[0].id);
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }

    await dispatchDeviceShadowOutboxEvent(app.pg, app.mongo.db, app.log, shadowOutboxId)
        .catch(error => app.log.warn({ error, mac }, 'Shadow unpair event queued for retry'));
    if (removalResult!.topologyOutboxId) {
        await dispatchTopologyOutboxEvent(
            app.pg,
            app.redis,
            app.mongo.db,
            app.log,
            removalResult!.topologyOutboxId,
        ).catch(error => app.log.warn({ error, mac }, 'Topology unpair event queued for retry'));
    }
    await invalidateDeviceContext(app, mac);

    return {
        mac,
        network_id: removalResult!.topology?.network_id ?? null,
        topology_epoch: removalResult!.topology?.topology_epoch ?? null,
        topology_state: removalResult!.topology?.topology_state ?? null,
        active_hub_device_id: removalResult!.topology?.active_hub_device_id ?? null,
        active_hub_mac: removalResult!.topology?.active_hub_mac ?? null,
        hub_changed: removalResult!.hubChanged,
    };
}

export async function listDevices(app: FastifyInstance, accountId: string) {
    const result = await app.pg.query(
        `SELECT device.id, device.owner_id, device.mac, device.name,
                device.product_id, device.catalog_revision,
                device.firmware_version, device.network_id, device.join_rank,
                device.is_active, device.claimed_at, device.created_at,
                device.updated_at, membership.role,
                COALESCE(
                    ARRAY_AGG(permission.permission_scope)
                        FILTER (WHERE permission.permission_scope IS NOT NULL),
                    ARRAY[]::text[]
                ) AS granted_permissions,
                network.active_hub_device_id, hub.mac AS active_hub_mac,
                network.topology_epoch, network.topology_state,
                network.updated_at AS last_transport_change,
                CASE
                    WHEN device.id = network.active_hub_device_id THEN 'hub'
                    WHEN device.network_id IS NOT NULL THEN 'node'
                    ELSE NULL
                END AS topology_role,
                CASE
                    WHEN device.id = network.active_hub_device_id THEN 'hub'
                    WHEN network.topology_state = 'stable' THEN 'relay'
                    WHEN device.network_id IS NOT NULL THEN 'direct_fallback'
                    ELSE NULL
                END AS transport_mode
         FROM device_metadata AS device
         JOIN device_memberships AS membership
           ON membership.device_id = device.id
          AND membership.account_id = $1
          AND membership.status = 'active'
          AND (membership.expires_at IS NULL OR membership.expires_at > NOW())
         LEFT JOIN device_membership_permissions AS permission
           ON permission.device_id = membership.device_id
          AND permission.account_id = membership.account_id
         LEFT JOIN device_networks AS network ON network.id = device.network_id
         LEFT JOIN device_metadata AS hub ON hub.id = network.active_hub_device_id
         WHERE device.is_active = true
         GROUP BY device.id, membership.role, network.id, hub.mac
         ORDER BY device.created_at DESC`,
        [accountId],
    );
    if (result.rows.length === 0) return [];

    const macs = result.rows.map(row => row.mac);
    const shadows = await app.mongo.db
        .collection<any>(env.MONGO_DEVICE_SHADOWS_COLLECTION)
        .find({ _id: { $in: macs } })
        .toArray();
    const shadowByMac = new Map(shadows.map(shadow => [shadow._id, shadow]));

    return result.rows.map(device => {
        const product = app.catalog.getProduct(device.product_id);
        const shadow = shadowByMac.get(device.mac);
        return {
            ...device,
            join_rank: device.join_rank === null ? null : Number(device.join_rank),
            topology_epoch: device.topology_epoch === null ? null : Number(device.topology_epoch),
            permissions: device.role === 'owner'
                ? (product?.permissions || [])
                : device.granted_permissions,
            shadow: {
                schema: 'device.state.v2',
                state_version: Number(shadow?.state_version || 0),
                instances: shadow?.instances || {},
                diagnostics: shadow?.diagnostics || {},
                is_online: Boolean(shadow?.is_online),
                last_seen: shadow?.last_seen || null,
                updated_at: shadow?.updated_at || null,
            },
        };
    });
}

export async function loadAccessibleDevice(app: FastifyInstance, mac: string, accountId: string) {
    const result = await app.pg.query(
        `SELECT device.id, device.owner_id, device.mac, device.product_id,
                device.catalog_revision, membership.role,
                COALESCE(ARRAY_AGG(permission.permission_scope)
                    FILTER (WHERE permission.permission_scope IS NOT NULL),
                    ARRAY[]::text[]) AS granted_permissions
         FROM device_metadata AS device
         JOIN device_memberships AS membership
           ON membership.device_id = device.id
          AND membership.account_id = $1
          AND membership.status = 'active'
          AND (membership.expires_at IS NULL OR membership.expires_at > NOW())
         LEFT JOIN device_membership_permissions AS permission
           ON permission.device_id = membership.device_id
          AND permission.account_id = membership.account_id
         WHERE device.mac = $2 AND device.is_active = true
         GROUP BY device.id, membership.role`,
        [accountId, mac],
    );
    return result.rows[0] || null;
}

export async function createDeviceOperation(app: FastifyInstance, input: {
    mac: string;
    instance_id: string;
    operation_name: string;
    input?: Record<string, unknown>;
    idempotency_key?: string;
    expected_state_version?: number;
    reauthenticated?: boolean;
    internal_context?: Record<string, unknown>;
    resource_session?: {
        id: string;
        resource_id: string;
        resource_kind: string;
        permission_scope: string;
        access_token_hash: string;
        expires_at: Date;
    };
}, accountId: string) {
    const mac = normalizeMac(input.mac);
    const device = await loadAccessibleDevice(app, mac, accountId);
    if (!device) throw buildError('Device not found', 404, 'DEVICE_NOT_FOUND');

    const product = app.catalog.getProduct(device.product_id);
    if (!product || product.catalog_revision !== device.catalog_revision) {
        throw buildError('Product catalog revision is unavailable', 409, 'PRODUCT_REVISION_UNAVAILABLE');
    }
    const operation = app.catalog.getOperation(
        device.product_id,
        input.instance_id,
        input.operation_name,
    ) as any;
    if (!operation) throw buildError('Operation is not supported by this Product', 400, 'OPERATION_NOT_SUPPORTED');
    if (
        !input.resource_session
        && Array.isArray(operation.effects)
        && operation.effects.some((effect: any) => effect.type === 'create_resource_session')
    ) {
        throw buildError(
            'Protected resources must be opened through a resource session',
            400,
            'RESOURCE_SESSION_REQUIRED',
        );
    }

    const isOwner = device.role === 'owner';
    if (!isOwner && !device.granted_permissions.includes(operation.permission)) {
        throw buildError('Permission denied for this operation', 403, 'OPERATION_FORBIDDEN');
    }
    if (operation.confirmation === 'reauthenticate' && !input.reauthenticated) {
        throw buildError('Recent reauthentication is required', 403, 'REAUTHENTICATION_REQUIRED');
    }

    const operationInput = input.input || {};
    const validation = validateObjectAgainstSchema(operationInput, operation.input || {});
    if (!validation.valid) {
        throw buildError(validation.error || 'Invalid operation input', 400, 'OPERATION_INPUT_INVALID');
    }

    if (input.expected_state_version !== undefined) {
        const shadow = await app.mongo.db
            .collection<any>(env.MONGO_DEVICE_SHADOWS_COLLECTION)
            .findOne({ _id: mac }, { projection: { state_version: 1 } });
        if (Number(shadow?.state_version || 0) !== input.expected_state_version) {
            throw buildError('Device state changed; refresh and try again', 409, 'STATE_VERSION_CONFLICT');
        }
    }

    if (input.idempotency_key) {
        const existing = await app.pg.query(
            `SELECT id, status FROM device_operations
             WHERE device_id = $1 AND idempotency_key = $2`,
            [device.id, input.idempotency_key],
        );
        if (existing.rows[0]) {
            return { operation_id: existing.rows[0].id, status: existing.rows[0].status };
        }
    }

    const operationId = crypto.randomUUID();
    const timeoutAt = new Date(Date.now() + Number(operation.timeout_ms) + 5000);
    const message = {
        schema: 'device.operation.v2',
        operation_id: operationId,
        owner_id: device.owner_id,
        actor_account_id: accountId,
        device_id: mac,
        product_id: device.product_id,
        catalog_revision: device.catalog_revision,
        instance_id: input.instance_id,
        operation_name: input.operation_name,
        input: operationInput,
        context: input.internal_context || {},
        topology: null,
        created_at: new Date().toISOString(),
        timeout_at: timeoutAt.toISOString(),
    };

    const client = await app.pg.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            `INSERT INTO device_operations
                (id, device_id, actor_account_id, instance_id, operation_name,
                 permission_scope, risk, input, idempotency_key,
                 expected_state_version, status, catalog_revision, timeout_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10,
                     'queued', $11, $12)`,
            [
                operationId,
                device.id,
                accountId,
                input.instance_id,
                input.operation_name,
                operation.permission,
                operation.risk,
                JSON.stringify(operationInput),
                input.idempotency_key || null,
                input.expected_state_version ?? null,
                device.catalog_revision,
                timeoutAt,
            ],
        );
        await client.query(
            `INSERT INTO device_operation_transitions
                (operation_id, from_status, to_status, metadata)
             VALUES ($1, NULL, 'accepted', '{}'::jsonb),
                    ($1, 'accepted', 'queued', '{}'::jsonb)`,
            [operationId],
        );
        await client.query(
            `INSERT INTO operation_outbox (operation_id, topic, payload)
             VALUES ($1, $2, $3::jsonb)`,
            [operationId, `smarthome/${mac}/control`, JSON.stringify(message)],
        );
        if (input.resource_session) {
            await client.query(
                `INSERT INTO device_resource_sessions
                    (id, device_id, actor_account_id, operation_id, instance_id,
                     resource_id, permission_scope, resource_kind, status,
                     access_token_hash, expires_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'requested', $9, $10)`,
                [
                    input.resource_session.id,
                    device.id,
                    accountId,
                    operationId,
                    input.instance_id,
                    input.resource_session.resource_id,
                    input.resource_session.permission_scope,
                    input.resource_session.resource_kind,
                    input.resource_session.access_token_hash,
                    input.resource_session.expires_at,
                ],
            );
        }
        await client.query('COMMIT');
    } catch (error: any) {
        await client.query('ROLLBACK');
        if (error?.code === '23505' && input.idempotency_key) {
            const existing = await app.pg.query(
                `SELECT id, status FROM device_operations
                 WHERE device_id = $1 AND idempotency_key = $2`,
                [device.id, input.idempotency_key],
            );
            if (existing.rows[0]) {
                return { operation_id: existing.rows[0].id, status: existing.rows[0].status };
            }
        }
        throw error;
    } finally {
        client.release();
    }
    return { operation_id: operationId, status: 'queued' };
}

export async function createDeviceResourceSession(app: FastifyInstance, input: {
    mac: string;
    instance_id: string;
    resource_id: string;
    idempotency_key?: string;
    reauthenticated?: boolean;
}, accountId: string) {
    const mac = normalizeMac(input.mac);
    const device = await loadAccessibleDevice(app, mac, accountId);
    if (!device) throw buildError('Device not found', 404, 'DEVICE_NOT_FOUND');
    const resource = app.catalog.getResource(
        device.product_id,
        input.instance_id,
        input.resource_id,
    ) as any;
    if (!resource) throw buildError('Resource is not supported by this Product', 400, 'RESOURCE_NOT_SUPPORTED');
    const isOwner = device.role === 'owner';
    if (!isOwner && !device.granted_permissions.includes(resource.permission)) {
        throw buildError('Permission denied for this resource', 403, 'RESOURCE_FORBIDDEN');
    }

    const product = app.catalog.getProduct(device.product_id) as any;
    const operation = Object.values(product?.operations || {}).find((candidate: any) => (
        candidate.instance_id === input.instance_id
        && candidate.ack_policy?.completion_signal === 'resource'
        && candidate.ack_policy?.reference === input.resource_id
    )) as any;
    if (!operation) {
        throw buildError('Resource has no session operation', 409, 'RESOURCE_OPERATION_UNAVAILABLE');
    }
    if (operation.confirmation === 'reauthenticate' && !input.reauthenticated) {
        throw buildError('Recent reauthentication is required', 403, 'REAUTHENTICATION_REQUIRED');
    }

    const rawToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + Number(resource.session_ttl_seconds) * 1000);
    const result = await createDeviceOperation(app, {
        mac,
        instance_id: input.instance_id,
        operation_name: operation.id,
        input: {},
        idempotency_key: input.idempotency_key,
        reauthenticated: input.reauthenticated,
        internal_context: {
            resource_session_id: sessionId,
            resource_id: input.resource_id,
            resource_expires_at: expiresAt.toISOString(),
        },
        resource_session: {
            id: sessionId,
            resource_id: input.resource_id,
            resource_kind: resource.kind,
            permission_scope: resource.permission,
            access_token_hash: tokenHash,
            expires_at: expiresAt,
        },
    }, accountId);
    return {
        session_id: sessionId,
        operation_id: result.operation_id,
        status: 'requested',
        access_token: rawToken,
        expires_at: expiresAt.toISOString(),
    };
}

export async function getDeviceResourceSession(
    app: FastifyInstance,
    macInput: string,
    sessionId: string,
    accountId: string,
) {
    const mac = normalizeMac(macInput);
    const result = await app.pg.query(
        `SELECT session.id, session.operation_id, session.instance_id,
                session.resource_id, session.resource_kind, session.status,
                session.resource_locator, session.reason_code, session.expires_at,
                session.ready_at, session.created_at
         FROM device_resource_sessions AS session
         JOIN device_metadata AS device ON device.id = session.device_id
         WHERE session.id = $1 AND session.actor_account_id = $2
           AND device.mac = $3 AND device.is_active = true`,
        [sessionId, accountId, mac],
    );
    if (!result.rows[0]) throw buildError('Resource session not found', 404, 'RESOURCE_SESSION_NOT_FOUND');
    const session = result.rows[0];
    if (session.status === 'requested' && new Date(session.expires_at).getTime() <= Date.now()) {
        await app.pg.query(
            `UPDATE device_resource_sessions SET status = 'expired'
             WHERE id = $1 AND status = 'requested'`,
            [sessionId],
        );
        session.status = 'expired';
    }
    return session;
}

function validateCredentialMaterial(material: string, credential: any) {
    const constraints = credential.constraints || {};
    if (constraints.format === 'numeric_secret' && !/^\d+$/.test(material)) {
        throw buildError('Credential must contain digits only', 400, 'CREDENTIAL_MATERIAL_INVALID');
    }
    if (
        material.length < Number(constraints.min_length || 1)
        || material.length > Number(constraints.max_length || 4096)
    ) {
        throw buildError('Credential length is invalid', 400, 'CREDENTIAL_MATERIAL_INVALID');
    }
}

export async function replaceDeviceCredential(app: FastifyInstance, input: {
    mac: string;
    instance_id: string;
    credential_name: string;
    label?: string;
    material: string;
    idempotency_key?: string;
    reauthenticated?: boolean;
}, accountId: string) {
    if (!input.reauthenticated) {
        throw buildError('Recent reauthentication is required', 403, 'REAUTHENTICATION_REQUIRED');
    }
    const mac = normalizeMac(input.mac);
    const device = await loadAccessibleDevice(app, mac, accountId);
    if (!device) throw buildError('Device not found', 404, 'DEVICE_NOT_FOUND');
    if (device.role !== 'owner') {
        throw buildError('Only the device owner may manage credentials', 403, 'CREDENTIAL_FORBIDDEN');
    }
    const credential = app.catalog.getCredential(
        device.product_id,
        input.instance_id,
        input.credential_name,
    ) as any;
    if (!credential) throw buildError('Credential is not supported by this Product', 400, 'CREDENTIAL_NOT_SUPPORTED');
    validateCredentialMaterial(input.material, credential);

    if (input.idempotency_key) {
        const existing = await app.pg.query(
            `SELECT id, status FROM credential_jobs
             WHERE device_id = $1 AND idempotency_key = $2`,
            [device.id, input.idempotency_key],
        );
        if (existing.rows[0]) return { job_id: existing.rows[0].id, status: existing.rows[0].status };
    }

    const factory = await app.pg.query(
        `SELECT credential_public_key_pem FROM factory_devices WHERE mac = $1`,
        [mac],
    );
    const publicKey = factory.rows[0]?.credential_public_key_pem;
    if (!publicKey) throw buildError('Device credential key is unavailable', 409, 'CREDENTIAL_KEY_UNAVAILABLE');

    const jobId = crypto.randomUUID();
    const credentialId = crypto.randomUUID();
    const label = input.label?.trim() || 'primary';
    const timeoutAt = new Date(Date.now() + 15000);
    const message = {
        schema: 'device.credential.v2',
        job_id: jobId,
        owner_id: device.owner_id,
        actor_account_id: accountId,
        device_id: mac,
        product_id: device.product_id,
        catalog_revision: device.catalog_revision,
        instance_id: input.instance_id,
        credential_name: input.credential_name,
        action: 'replace',
        encrypted_envelope: {
            algorithm: 'RSA-OAEP-256+A256GCM',
            encrypted_key_base64: '',
            iv_base64: '',
            ciphertext_base64: '',
            auth_tag_base64: '',
        },
        created_at: new Date().toISOString(),
        timeout_at: timeoutAt.toISOString(),
    };

    const client = await app.pg.connect();
    try {
        await client.query('BEGIN');
        const current = await client.query(
            `SELECT id FROM device_credentials
             WHERE device_id = $1 AND instance_id = $2 AND credential_name = $3
               AND label = $4 AND status IN ('pending', 'active')
             FOR UPDATE`,
            [device.id, input.instance_id, input.credential_name, label],
        );
        const storedCredentialId = current.rows[0]?.id || credentialId;
        if (current.rows[0]) {
            await client.query(
                `UPDATE device_credentials
                 SET status = 'pending', catalog_revision = $2, rotated_at = NOW(),
                     revoked_at = NULL
                 WHERE id = $1`,
                [storedCredentialId, device.catalog_revision],
            );
        } else {
            await client.query(
                `INSERT INTO device_credentials
                    (id, device_id, instance_id, credential_name, credential_kind,
                     label, status, created_by, catalog_revision)
                 VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)`,
                [
                    storedCredentialId, device.id, input.instance_id,
                    input.credential_name, credential.kind, label, accountId,
                    device.catalog_revision,
                ],
            );
        }
        const envelopeKey = crypto.randomBytes(32);
        const envelopeIv = crypto.randomBytes(12);
        const envelopeCipher = crypto.createCipheriv('aes-256-gcm', envelopeKey, envelopeIv);
        const envelopePlaintext = Buffer.from(JSON.stringify({
            job_id: jobId,
            credential_id: storedCredentialId,
            instance_id: input.instance_id,
            credential_name: input.credential_name,
            material: input.material,
        }), 'utf8');
        const envelopeCiphertext = Buffer.concat([
            envelopeCipher.update(envelopePlaintext),
            envelopeCipher.final(),
        ]);
        message.encrypted_envelope.encrypted_key_base64 = crypto.publicEncrypt(
            {
                key: publicKey,
                padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
                oaepHash: 'sha256',
            },
            envelopeKey,
        ).toString('base64');
        message.encrypted_envelope.iv_base64 = envelopeIv.toString('base64');
        message.encrypted_envelope.ciphertext_base64 = envelopeCiphertext.toString('base64');
        message.encrypted_envelope.auth_tag_base64 = envelopeCipher.getAuthTag().toString('base64');
        await client.query(
            `INSERT INTO credential_jobs
                (id, device_id, credential_id, actor_account_id, instance_id,
                 credential_name, action, status, catalog_revision,
                 idempotency_key, timeout_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', $8, $9, $10)`,
            [
                jobId, device.id, storedCredentialId, accountId,
                input.instance_id, input.credential_name,
                current.rows[0] ? 'rotate' : 'enroll', device.catalog_revision,
                input.idempotency_key || null, timeoutAt,
            ],
        );
        await client.query(
            `INSERT INTO credential_outbox (job_id, payload)
             VALUES ($1, $2::jsonb)`,
            [jobId, JSON.stringify(message)],
        );
        await client.query('COMMIT');
    } catch (error: any) {
        await client.query('ROLLBACK');
        if (error?.code === '23505' && input.idempotency_key) {
            const existing = await app.pg.query(
                `SELECT id, status FROM credential_jobs
                 WHERE device_id = $1 AND idempotency_key = $2`,
                [device.id, input.idempotency_key],
            );
            if (existing.rows[0]) return { job_id: existing.rows[0].id, status: existing.rows[0].status };
        }
        throw error;
    } finally {
        client.release();
    }
    return { job_id: jobId, status: 'queued' };
}

export async function listDeviceCredentials(
    app: FastifyInstance,
    macInput: string,
    accountId: string,
) {
    const mac = normalizeMac(macInput);
    const device = await loadAccessibleDevice(app, mac, accountId);
    if (!device) throw buildError('Device not found', 404, 'DEVICE_NOT_FOUND');
    if (device.role !== 'owner') {
        throw buildError('Only the device owner may view credential metadata', 403, 'CREDENTIAL_FORBIDDEN');
    }
    const result = await app.pg.query(
        `SELECT id, instance_id, credential_name, credential_kind, label,
                metadata, status, rotated_at, revoked_at, created_at, updated_at
         FROM device_credentials
         WHERE device_id = $1
         ORDER BY created_at ASC`,
        [device.id],
    );
    return result.rows;
}

export async function getDeviceState(app: FastifyInstance, macInput: string, accountId: string) {
    const mac = normalizeMac(macInput);
    if (!(await loadAccessibleDevice(app, mac, accountId))) {
        throw buildError('Forbidden', 403, 'DEVICE_FORBIDDEN');
    }
    const shadow = await app.mongo.db
        .collection<any>(env.MONGO_DEVICE_SHADOWS_COLLECTION)
        .findOne({ _id: mac });
    return {
        schema: 'device.state.v2',
        state_version: Number(shadow?.state_version || 0),
        instances: shadow?.instances || {},
        diagnostics: shadow?.diagnostics || {},
        is_online: Boolean(shadow?.is_online),
        last_seen: shadow?.last_seen || null,
        updated_at: shadow?.updated_at || null,
    };
}

export async function updateDeviceName(
    app: FastifyInstance,
    macInput: string,
    name: string,
    ownerId: string,
) {
    const mac = normalizeMac(macInput);
    const trimmedName = name.trim();
    if (!trimmedName) throw buildError('Device name cannot be empty', 400, 'INVALID_DEVICE_NAME');

    const client = await app.pg.connect();
    let device: any;
    let outboxId = 0;
    try {
        await client.query('BEGIN');
        const result = await client.query(
            `UPDATE device_metadata
             SET name = $1
             WHERE owner_id = $2 AND mac = $3 AND is_active = true
             RETURNING id, owner_id, mac, name, product_id, catalog_revision,
                       firmware_version, network_id, join_rank, is_active,
                       created_at, updated_at`,
            [trimmedName, ownerId, mac],
        );
        if (!result.rows[0]) throw buildError('Device not found', 404, 'DEVICE_NOT_FOUND');
        device = result.rows[0];
        const outbox = await client.query(
            `INSERT INTO device_shadow_outbox (device_id, mac, operation, payload)
             VALUES ($1, $2, 'rename', $3::jsonb)
             RETURNING id`,
            [device.id, mac, JSON.stringify({ name: trimmedName })],
        );
        outboxId = Number(outbox.rows[0].id);
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
    await dispatchDeviceShadowOutboxEvent(app.pg, app.mongo.db, app.log, outboxId)
        .catch(error => app.log.warn({ error, mac }, 'Shadow rename event queued for retry'));
    return device;
}

export async function syncOwnershipToRedis(app: FastifyInstance) {
    const result = await app.pg.query(
        `SELECT mac, owner_id, product_id, catalog_revision
         FROM device_metadata WHERE is_active = true`,
    );
    let cursor = '0';
    do {
        const [next, keys] = await app.redis.scan(
            cursor,
            'MATCH',
            `${CACHE_PREFIXES.OWNER_OF}*`,
            'COUNT',
            500,
        );
        cursor = next;
        if (keys.length > 0) await app.redis.del(...keys);
    } while (cursor !== '0');

    if (result.rows.length === 0) return;
    const pipeline = app.redis.pipeline();
    for (const row of result.rows) {
        pipeline.set(
            `${CACHE_PREFIXES.OWNER_OF}${row.mac}`,
            row.owner_id,
            'EX',
            env.REDIS_CACHE_TTL_SECONDS,
        );
        pipeline.set(
            `${CACHE_PREFIXES.PRODUCT_OF}${row.mac}`,
            row.product_id,
            'EX',
            env.REDIS_CACHE_TTL_SECONDS,
        );
        pipeline.set(
            `${CACHE_PREFIXES.CATALOG_REVISION_OF}${row.mac}`,
            String(row.catalog_revision),
            'EX',
            env.REDIS_CACHE_TTL_SECONDS,
        );
    }
    const responses = await pipeline.exec();
    const failed = responses?.find(([error]) => error);
    if (failed) throw failed[0];
}
