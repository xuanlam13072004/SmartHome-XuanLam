import { WebSocket } from 'ws';
import { getDb } from '../loaders/mongo.js';
import { env } from '../config/env.js';
import { safeSend } from '../utils/safeSend.js';

const activeConnections = new Map<string, Set<WebSocket>>();

export function addConnection(accountId: string, socket: WebSocket): boolean {
    const sockets = activeConnections.get(accountId) || new Set<WebSocket>();
    if (sockets.size >= env.WS_MAX_CONNECTIONS_PER_USER) return false;
    sockets.add(socket);
    activeConnections.set(accountId, sockets);
    return true;
}

export function removeConnection(accountId: string, socket: WebSocket): void {
    const sockets = activeConnections.get(accountId);
    if (!sockets) return;
    sockets.delete(socket);
    if (sockets.size === 0) activeConnections.delete(accountId);
}

export function getConnections(accountId: string): Set<WebSocket> | undefined {
    return activeConnections.get(accountId);
}

export function sendToUser(accountId: string, data: any): void {
    const payload = JSON.stringify(data);
    for (const socket of activeConnections.get(accountId) || []) safeSend(socket, payload);
}

export async function sendInitialState(accountId: string, socket: WebSocket): Promise<void> {
    try {
        const db = getDb();
        const shadows = await db
            .collection(env.MONGO_DEVICE_SHADOWS_COLLECTION)
            .find({ access_account_ids: accountId, is_active: { $ne: false } })
            .toArray();
        const devices = shadows.map(shadow => {
            const ownerId = shadow.owner_id?.toString() || '';
            const isOwner = ownerId === accountId;
            const accessGrant = Array.isArray(shadow.access_grants)
                ? shadow.access_grants.find(
                    (grant: any) => grant?.account_id?.toString() === accountId,
                )
                : null;
            const ownerPermissions = Array.isArray(shadow.owner_permissions)
                ? shadow.owner_permissions
                : [];
            const grantedPermissions = Array.isArray(accessGrant?.permissions)
                ? accessGrant.permissions
                : [];
            return {
                mac: shadow._id.toString(),
                name: shadow.name || null,
                owner_id: ownerId || null,
                product_id: shadow.product_id,
                catalog_revision: shadow.catalog_revision,
                // Role: owner if the connecting user owns the device, otherwise member.
                role: isOwner ? 'owner' : (accessGrant?.role || 'member'),
                permissions: isOwner ? ownerPermissions : grantedPermissions,
                is_active: shadow.is_active !== false,
                shadow: {
                    schema: 'device.state.v2',
                    state_version: Number(shadow.state_version || 0),
                    instances: shadow.instances || {},
                    diagnostics: shadow.diagnostics || {},
                    is_online: Boolean(shadow.is_online),
                    last_seen: shadow.last_seen instanceof Date
                        ? shadow.last_seen.toISOString()
                        : shadow.last_seen || null,
                    updated_at: shadow.updated_at instanceof Date
                        ? shadow.updated_at.toISOString()
                        : shadow.updated_at || null,
                },
                network_id: shadow.network_id || null,
                join_rank: shadow.join_rank ?? null,
                topology_role: shadow.topology_role || null,
                topology_epoch: shadow.topology_epoch ?? null,
                topology_state: shadow.topology_state || null,
                active_hub_mac: shadow.active_hub_mac || null,
                transport_mode: shadow.transport_mode || null,
            };
        });
        safeSend(socket, JSON.stringify({ event: 'initial_state', devices }));

        const activeOperations = await db
            .collection(env.MONGO_ACTIVE_OPERATIONS_COLLECTION)
            .find({ 'operation.actor_account_id': accountId })
            .toArray();
        safeSend(socket, JSON.stringify({
            event: 'active_operations',
            operations: activeOperations.map(item => ({
                operation_id: item._id.toString(),
                device_id: item.device_id,
                status: item.status,
                operation: item.operation,
                expires_at: item.expires_at instanceof Date
                    ? item.expires_at.toISOString()
                    : item.expires_at,
            })),
        }));
    } catch (error) {
        console.error('Failed to load realtime initial state:', error);
        safeSend(socket, JSON.stringify({
            event: 'error',
            message: 'Failed to retrieve initial device state',
        }));
    }
}
