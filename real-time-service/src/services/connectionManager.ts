import { WebSocket } from 'ws';
import { getDb } from '../loaders/mongo.js';
import { env } from '../config/env.js';
import { safeSend } from '../utils/safeSend.js';

// Map structure: owner_id -> Set of active WebSocket connections
const activeConnections = new Map<string, Set<WebSocket>>();

export function addConnection(ownerId: string, socket: WebSocket): void {
    let sockets = activeConnections.get(ownerId);
    if (!sockets) {
        sockets = new Set<WebSocket>();
        activeConnections.set(ownerId, sockets);
    }
    sockets.add(socket);
    console.log(`🔌 Registered socket for user: ${ownerId}. Total sockets: ${sockets.size}`);
}

export function removeConnection(ownerId: string, socket: WebSocket): void {
    const sockets = activeConnections.get(ownerId);
    if (sockets) {
        sockets.delete(socket);
        if (sockets.size === 0) {
            activeConnections.delete(ownerId);
        }
        console.log(`🔌 Unregistered socket for user: ${ownerId}. Remaining: ${sockets.size}`);
    }
}

export function getConnections(ownerId: string): Set<WebSocket> | undefined {
    return activeConnections.get(ownerId);
}

export function sendToUser(ownerId: string, data: any): void {
    const sockets = activeConnections.get(ownerId);
    if (!sockets || sockets.size === 0) {
        return;
    }

    const payload = JSON.stringify(data);
    for (const socket of sockets) {
        safeSend(socket, payload);
    }
}

export async function sendInitialState(ownerId: string, socket: WebSocket): Promise<void> {
    try {
        const db = getDb();
        const collection = db.collection(env.MONGO_DEVICES_COLLECTION);
        
        // Find all devices owned by this user
        const cursor = collection.find({ owner_id: ownerId });
        const devices = await cursor.toArray();

        const mappedDevices = devices.map(doc => ({
            mac: doc._id.toString(),
            name: doc.name || null,
            product_id: doc.product_id || null,
            is_online: doc.is_online ?? false,
            state: doc.state || {},
            diagnostics: doc.diagnostics || {},
            rssi: doc.diagnostics?.rssi ?? doc.rssi ?? null,
            battery: doc.diagnostics?.battery ?? doc.battery ?? null,
            last_seen: doc.last_seen instanceof Date ? doc.last_seen.toISOString() : (doc.last_seen || null),
        }));

        const response = {
            event: 'initial_state',
            devices: mappedDevices,
        };

        safeSend(socket, JSON.stringify(response));
        console.log(`📤 Sent initial_state containing ${mappedDevices.length} devices to user ${ownerId}`);

        // Command State Recovery: retrieve and send active commands for the user
        try {
            const activeCommandsCol = db.collection('active_commands');
            const activeCmds = await activeCommandsCol.find({ owner_id: ownerId }).toArray();
            
            const mappedCmds = activeCmds.map(cmd => {
                let parsedCommand = {};
                try {
                    parsedCommand = typeof cmd.command === 'string' ? JSON.parse(cmd.command) : (cmd.command || {});
                } catch (err) {
                    console.error(`Failed to parse command payload for command ${cmd._id}:`, err);
                }
                return {
                    command_id: cmd._id.toString(),
                    mac: cmd.mac,
                    command: parsedCommand,
                    status: cmd.status,
                    event_version: cmd.event_version || 1,
                    created_at: cmd.created_at instanceof Date ? cmd.created_at.toISOString() : (cmd.created_at || null),
                };
            });

            const commandsResponse = {
                event: 'active_commands',
                commands: mappedCmds,
            };

            safeSend(socket, JSON.stringify(commandsResponse));
            console.log(`📤 Sent active_commands containing ${mappedCmds.length} commands to user ${ownerId}`);
        } catch (cmdErr) {
            console.error(`❌ Failed to retrieve and send active commands for user ${ownerId}:`, cmdErr);
        }
    } catch (err) {
        console.error(`❌ Failed to retrieve and send initial state for user ${ownerId}:`, err);
        safeSend(socket, JSON.stringify({
            event: 'error',
            message: 'Failed to retrieve initial device state',
        }));
    }
}
