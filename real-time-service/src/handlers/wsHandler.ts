import { WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { addConnection, removeConnection, sendInitialState } from '../services/connectionManager.js';
import { safeSend } from '../utils/safeSend.js';

interface JWTPayload {
    userId: string;
    email?: string;
    iat?: number;
    exp?: number;
}

export function handleConnection(socket: WebSocket, req: IncomingMessage): void {
    let isAuthenticated = false;
    let ownerId: string | null = null;
    let isAlive = true;

    // Timeout timer for unauthenticated connections
    let authTimeout: NodeJS.Timeout | null = null;

    // Helper to send error and close connection
    const rejectConnection = (reason: string, closeCode: number = 4001) => {
        safeSend(socket, JSON.stringify({ event: 'error', message: reason }));
        if (socket.readyState === WebSocket.OPEN) {
            socket.close(closeCode, reason);
        }
        cleanup();
    };

    const cleanup = () => {
        if (authTimeout) {
            clearTimeout(authTimeout);
            authTimeout = null;
        }
        if (isAuthenticated && ownerId) {
            removeConnection(ownerId, socket);
        }
    };

    // Try token auth via HTTP Authorization header first
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        try {
            const decoded = jwt.verify(token, env.JWT_SECRET) as JWTPayload;
            if (decoded && decoded.userId) {
                isAuthenticated = true;
                ownerId = decoded.userId;
                if (!addConnection(ownerId, socket)) {
                    isAuthenticated = false;
                    rejectConnection('Connection limit exceeded', 4008);
                    return;
                }
                console.log(`✅ User ${ownerId} authenticated via Authorization header.`);
                
                // Send initial state
                sendInitialState(ownerId, socket).catch((err) => {
                    console.error('Error sending initial state:', err);
                });
            } else {
                rejectConnection('Invalid token payload');
                return;
            }
        } catch (err) {
            console.warn('⚠️ Header auth failed, closing connection:', err);
            rejectConnection('Invalid authentication token');
            return;
        }
    } else {
        // Fallback: Message-based authentication (must happen within 5 seconds)
        authTimeout = setTimeout(() => {
            if (!isAuthenticated) {
                console.log('⏰ Authentication timeout. Closing connection.');
                rejectConnection('Authentication Timeout');
            }
        }, 5000);
    }

    // Ping/Pong Heartbeat Keep-Alive setup
    socket.on('pong', () => {
        isAlive = true;
    });

    // Handle incoming messages
    socket.on('message', async (data) => {
        try {
            const messageStr = data.toString();
            let parsed: any;
            try {
                parsed = JSON.parse(messageStr);
            } catch (e) {
                if (!isAuthenticated) {
                    rejectConnection('Invalid JSON. Authentication required.');
                } else {
                    safeSend(socket, JSON.stringify({ event: 'error', message: 'Malformed JSON' }));
                }
                return;
            }

            if (!isAuthenticated) {
                // The first event must be "auth"
                if (parsed.event === 'auth') {
                    const token = parsed.payload?.token || parsed.token;
                    if (!token) {
                        rejectConnection('Token missing in auth payload');
                        return;
                    }

                    try {
                        const decoded = jwt.verify(token, env.JWT_SECRET) as JWTPayload;
                        if (decoded && decoded.userId) {
                            isAuthenticated = true;
                            ownerId = decoded.userId;
                            if (authTimeout) {
                                clearTimeout(authTimeout);
                                authTimeout = null;
                            }
                            if (!addConnection(ownerId, socket)) {
                                isAuthenticated = false;
                                rejectConnection('Connection limit exceeded', 4008);
                                return;
                            }
                            console.log(`✅ User ${ownerId} authenticated via auth message.`);
                            
                            safeSend(socket, JSON.stringify({ event: 'auth_success', message: 'Authenticated successfully' }));

                            // Push initial state
                            await sendInitialState(ownerId, socket);
                        } else {
                            rejectConnection('Invalid token payload');
                        }
                    } catch (err) {
                        console.warn('⚠️ Message auth failed:', err);
                        rejectConnection('Invalid authentication token');
                    }
                } else {
                    rejectConnection('Authentication required');
                }
            } else {
                // Client is already authenticated.
                // WS server is primarily push-only, but let's handle a manual text 'ping' as well
                if (parsed.event === 'ping') {
                    safeSend(socket, JSON.stringify({ event: 'pong', timestamp: new Date().toISOString() }));
                }
            }
        } catch (err) {
            console.error('Error handling WebSocket message:', err);
        }
    });

    socket.on('close', (code, reason) => {
        console.log(`🔌 WebSocket connection closed. Code: ${code}, Reason: ${reason}`);
        cleanup();
    });

    socket.on('error', (err) => {
        console.error('❌ WebSocket error occurred:', err);
        cleanup();
    });

    // Periodically verify that this socket is still alive (checked by index.ts ping interval)
    (socket as any).isAlive = () => isAlive;
    (socket as any).setDead = () => { isAlive = false; };
}
