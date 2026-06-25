import { WebSocket } from 'ws';

// 512 KB threshold for bufferedAmount to prevent memory bloat/OOM on slow connections
const MAX_BUFFERED_AMOUNT = 512 * 1024;

/**
 * safeSend
 * - Safely sends stringified JSON data over WebSocket connection.
 * - Protects server against memory leak/OOM by terminating connections where bufferedAmount exceeds MAX_BUFFERED_AMOUNT.
 * 
 * @param socket WebSocket connection instance
 * @param dataStr Stringified message payload
 * @returns boolean true if sent successfully, false otherwise
 */
export function safeSend(socket: WebSocket, dataStr: string): boolean {
    if (socket.readyState !== WebSocket.OPEN) {
        return false;
    }

    // Check backpressure bufferedAmount
    if (socket.bufferedAmount > MAX_BUFFERED_AMOUNT) {
        console.warn(`⚠️ [Backpressure] Client bufferedAmount (${socket.bufferedAmount} bytes) exceeded limit of ${MAX_BUFFERED_AMOUNT} bytes. Terminating connection immediately to protect server RAM.`);
        socket.terminate(); // Force close immediately without waiting for handshake close frames
        return false;
    }

    try {
        socket.send(dataStr);
        return true;
    } catch (err) {
        console.error('❌ Error sending WebSocket message in safeSend:', err);
        return false;
    }
}
