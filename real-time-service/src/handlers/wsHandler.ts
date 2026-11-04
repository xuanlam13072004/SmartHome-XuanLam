import { WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { addConnection, removeConnection, sendInitialState } from '../services/connectionManager.js';
import { AccessTokenRejectedError, verifyAccessToken } from '../services/accessTokenVerifier.js';
import { safeSend } from '../utils/safeSend.js';

const AUTH_TIMEOUT_MS = 5000;
// setTimeout cannot exceed a signed 32-bit delay.
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function handleConnection(socket: WebSocket, req: IncomingMessage): void {
    let isAuthenticated = false;
    let authInProgress = false;
    let ownerId: string | null = null;
    let isAlive = true;
    let closed = false;

    let authTimeout: NodeJS.Timeout | null = null;
    let expiryTimer: NodeJS.Timeout | null = null;

    const cleanup = () => {
        if (authTimeout) {
            clearTimeout(authTimeout);
            authTimeout = null;
        }
        if (expiryTimer) {
            clearTimeout(expiryTimer);
            expiryTimer = null;
        }
        if (isAuthenticated && ownerId) {
            removeConnection(ownerId, socket);
        }
        isAuthenticated = false;
    };

    const rejectConnection = (reason: string, closeCode: number = 4001) => {
        safeSend(socket, JSON.stringify({ event: 'error', message: reason }));
        if (socket.readyState === WebSocket.OPEN) {
            socket.close(closeCode, reason);
        }
        cleanup();
    };

    /**
     * Authenticates once per connection. The access token is checked against
     * API Gateway (account status + token_version) and the socket is closed when
     * the token expires, so the client reconnects with a refreshed token and a
     * revoked account cannot keep receiving device data.
     */
    const authenticate = async (token: string, acknowledge: boolean) => {
        authInProgress = true;
        try {
            const access = await verifyAccessToken(token);
            if (closed) return;
            if (access.expiresAtMs <= Date.now()) {
                rejectConnection('Access token expired');
                return;
            }
            if (!addConnection(access.userId, socket)) {
                rejectConnection('Connection limit exceeded', 4008);
                return;
            }
            isAuthenticated = true;
            ownerId = access.userId;
            if (authTimeout) {
                clearTimeout(authTimeout);
                authTimeout = null;
            }
            expiryTimer = setTimeout(() => {
                safeSend(socket, JSON.stringify({ event: 'token_expired', message: 'Access token expired' }));
                rejectConnection('Access token expired');
            }, Math.min(access.expiresAtMs - Date.now(), MAX_TIMER_DELAY_MS));
            expiryTimer.unref();

            console.log(`✅ User ${ownerId} authenticated.`);
            if (acknowledge) {
                safeSend(socket, JSON.stringify({ event: 'auth_success', message: 'Authenticated successfully' }));
            }
            await sendInitialState(access.userId, socket);
        } catch (err) {
            if (err instanceof AccessTokenRejectedError) {
                console.warn('⚠️ WebSocket authentication rejected:', err.message);
                rejectConnection(err.message);
            } else {
                console.error('❌ WebSocket authentication unavailable:', err);
                rejectConnection('Authentication service unavailable', 1013);
            }
        } finally {
            authInProgress = false;
        }
    };

    // Unauthenticated connections must complete auth within AUTH_TIMEOUT_MS.
    authTimeout = setTimeout(() => {
        if (!isAuthenticated) {
            console.log('⏰ Authentication timeout. Closing connection.');
            rejectConnection('Authentication Timeout');
        }
    }, AUTH_TIMEOUT_MS);

    // Token via HTTP Authorization header, otherwise the first message must be "auth".
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
        void authenticate(authHeader.substring(7), false);
    }

    socket.on('pong', () => {
        isAlive = true;
    });

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
                if (authInProgress) return;
                if (parsed.event === 'auth') {
                    const token = parsed.payload?.token || parsed.token;
                    if (typeof token !== 'string' || !token) {
                        rejectConnection('Token missing in auth payload');
                        return;
                    }
                    await authenticate(token, true);
                } else {
                    rejectConnection('Authentication required');
                }
                return;
            }

            // Authenticated sockets are push-only apart from an application-level ping.
            if (parsed.event === 'ping') {
                safeSend(socket, JSON.stringify({ event: 'pong', timestamp: new Date().toISOString() }));
            }
        } catch (err) {
            console.error('Error handling WebSocket message:', err);
        }
    });

    socket.on('close', (code, reason) => {
        closed = true;
        console.log(`🔌 WebSocket connection closed. Code: ${code}, Reason: ${reason}`);
        cleanup();
    });

    socket.on('error', (err) => {
        console.error('❌ WebSocket error occurred:', err);
        cleanup();
    });

    // Checked by the ping interval in server.ts
    (socket as any).isAlive = () => isAlive;
    (socket as any).setDead = () => { isAlive = false; };
}
