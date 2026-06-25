import http from 'http';
import { WebSocketServer } from 'ws';
import { env } from './config/env.js';
import { handleConnection } from './handlers/wsHandler.js';

let httpServer: http.Server | null = null;
let wss: WebSocketServer | null = null;
let pingInterval: NodeJS.Timeout | null = null;

export function startServer(): Promise<http.Server> {
    return new Promise((resolve) => {
        httpServer = http.createServer((req, res) => {
            if (req.url === '/health') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'ok', service: 'real-time-service' }));
            } else {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Not Found');
            }
        });

        // Initialize WebSocket Server on /ws path
        wss = new WebSocketServer({
            server: httpServer,
            path: '/ws',
        });

        wss.on('connection', (socket, req) => {
            console.log(`🔌 New client handshaking from ${req.socket.remoteAddress}`);
            handleConnection(socket, req);
        });

        // Set up 30-second Ping/Pong keep-alive
        pingInterval = setInterval(() => {
            if (!wss) return;
            wss.clients.forEach((client: any) => {
                if (typeof client.isAlive === 'function') {
                    if (client.isAlive() === false) {
                        console.log('🔌 Terminating unresponsive client connection.');
                        return client.terminate();
                    }
                    client.setDead();
                    client.ping();
                }
            });
        }, 30000);

        httpServer.listen(env.PORT, env.HOST, () => {
            console.log(`🚀 WebSocket server running at ws://${env.HOST}:${env.PORT}/ws`);
            resolve(httpServer!);
        });
    });
}

export function stopServer(): Promise<void> {
    return new Promise((resolve) => {
        if (pingInterval) {
            clearInterval(pingInterval);
            pingInterval = null;
        }

        if (wss) {
            wss.close(() => {
                console.log('WebSocket server closed.');
                wss = null;
                if (httpServer) {
                    httpServer.close(() => {
                        console.log('HTTP server closed.');
                        httpServer = null;
                        resolve();
                    });
                } else {
                    resolve();
                }
            });
        } else if (httpServer) {
            httpServer.close(() => {
                console.log('HTTP server closed.');
                httpServer = null;
                resolve();
            });
        } else {
            resolve();
        }
    });
}
