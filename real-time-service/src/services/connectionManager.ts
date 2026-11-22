import { WebSocket } from 'ws';
import { getDb } from '../loaders/mongo.js';
import { env } from '../config/env.js';
import { safeSend } from '../utils/safeSend.js';
import { eventLabel, messagesSent } from './metrics.js';

const activeConnections = new Map<string, Set<WebSocket>>();
/** Login session (access-token `sid`) of each socket, to close it when that session is signed out. */
const socketSessions = new WeakMap<WebSocket, string>();

/**
 * Live audience of each device on this instance: the connected accounts that
 * may see it (owner and shared members). Filled from the initial snapshot,
 * updated on DEVICE_ACCESS_CHANGED, so routing a message never needs a
 * database lookup. Only connected accounts are held, which bounds memory.
 */
const deviceAudience = new Map<string, Set<string>>();
const accountDevices = new Map<string, Set<string>>();

export function addConnection(accountId: string, socket: WebSocket, sessionId: string | null = null): boolean {
    const sockets = activeConnections.get(accountId) || new Set<WebSocket>();
    if (sockets.size >= env.WS_MAX_CONNECTIONS_PER_USER) return false;
    sockets.add(socket);
    activeConnections.set(accountId, sockets);
    if (sessionId) socketSessions.set(socket, sessionId);
    return true;
}

export function removeConnection(accountId: string, socket: WebSocket): void {
    const sockets = activeConnections.get(accountId);
    if (!sockets) return;
    sockets.delete(socket);
    if (sockets.size === 0) {
        activeConnections.delete(accountId);
        forgetAudience(accountId);
    }
}

function joinAudience(accountId: string, mac: string): boolean {
    const audience = deviceAudience.get(mac) || new Set<string>();
    if (audience.has(accountId)) return false;
    audience.add(accountId);
    deviceAudience.set(mac, audience);
    const devices = accountDevices.get(accountId) || new Set<string>();
    devices.add(mac);
    accountDevices.set(accountId, devices);
    return true;
}

function leaveAudience(accountId: string, mac: string): boolean {
    const audience = deviceAudience.get(mac);
    if (!audience?.delete(accountId)) return false;
    if (audience.size === 0) deviceAudience.delete(mac);
    const devices = accountDevices.get(accountId);
    devices?.delete(mac);
    if (devices?.size === 0) accountDevices.delete(accountId);
    return true;
}

function forgetAudience(accountId: string): void {
    for (const mac of accountDevices.get(accountId) || []) {
        const audience = deviceAudience.get(mac);
        audience?.delete(accountId);
        if (audience?.size === 0) deviceAudience.delete(mac);
    }
    accountDevices.delete(accountId);
}

/** Connected accounts that receive live updates of a device; the owner always does. */
export function recipientsOf(mac: string | null | undefined, ownerId: string): string[] {
    const audience = mac ? deviceAudience.get(mac) : undefined;
    if (!audience) return [ownerId];
    return audience.has(ownerId) ? [...audience] : [ownerId, ...audience];
}

/**
 * Who may see `mac` changed (PostgreSQL is the authority; the Gateway sends
 * the full list). Removed accounts stop receiving updates at once and are told
 * so; connected accounts that gained access are told to reload their devices.
 */
export function applyAccessChange(mac: string, accessAccountIds: string[], removedAccountIds: string[]): void {
    const allowed = new Set(accessAccountIds);
    const lost = new Set(removedAccountIds);
    for (const accountId of deviceAudience.get(mac) || []) {
        if (!allowed.has(accountId)) lost.add(accountId);
    }
    for (const accountId of lost) {
        if (allowed.has(accountId)) continue;
        leaveAudience(accountId, mac);
        sendToUser(accountId, { event: 'device_access_revoked', mac });
    }
    for (const accountId of allowed) {
        if (!activeConnections.has(accountId)) continue;
        if (joinAudience(accountId, mac)) sendToUser(accountId, { event: 'device_access_granted', mac });
    }
}

/** Closes the sockets of signed-out login sessions (or of every session of the account). */
export function closeSessions(accountId: string, sessionIds: string[] | 'all'): number {
    const targets = sessionIds === 'all' ? null : new Set(sessionIds);
    let closed = 0;
    for (const socket of [...(activeConnections.get(accountId) || [])]) {
        const sessionId = socketSessions.get(socket);
        if (targets && !(sessionId && targets.has(sessionId))) continue;
        safeSend(socket, JSON.stringify({ event: 'session_revoked', message: 'Signed out' }));
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
            socket.close(4003, 'Session revoked');
        }
        removeConnection(accountId, socket);
        closed += 1;
    }
    return closed;
}

export function getConnections(accountId: string): Set<WebSocket> | undefined {
    return activeConnections.get(accountId);
}

export function sendToUser(accountId: string, data: any): void {
    const sockets = activeConnections.get(accountId);
    if (!sockets || sockets.size === 0) return;
    const payload = JSON.stringify(data);
    for (const socket of sockets) safeSend(socket, payload);
    messagesSent.inc({ event: eventLabel(data?.event) }, sockets.size);
}

/** Open sockets and connected accounts on this instance (metrics). */
export function connectionStats(): { sockets: number; accounts: number } {
    let sockets = 0;
    for (const set of activeConnections.values()) sockets += set.size;
    return { sockets, accounts: activeConnections.size };
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
        // Only a still-open socket joins the live audience of these devices.
        if (activeConnections.get(accountId)?.has(socket)) {
            for (const device of devices) joinAudience(accountId, device.mac);
        }
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
