/**
 * Camera side of smarthome-media-ingest.v1 (camera contract 6.2): the virtual
 * camera dials out to the media relay exactly like a physical camera would.
 * Uses the WebSocket client built into Node 22.
 */
export const INGEST_PROTOCOL = 'smarthome-media-ingest.v1';
export const FRAME_INIT = 0x10;
export const FRAME_FRAGMENT = 0x11;
export const FRAME_FETCH_DATA = 0x12;

export interface IngestTarget {
    url: string;
    sessionId: string;
    token: string;
    mac: string;
    kind: 'live' | 'playback';
    profileId?: string | null;
}

export type RelayMessage =
    | { type: 'ready'; session_id: string }
    | { type: 'viewers'; count: number }
    | { type: 'stop'; reason: string }
    | { type: 'fetch'; request_id: number; segment_id: string; offset: number; length: number | null }
    | { type: 'cancel_fetch'; request_id: number }
    | { type: 'error'; code: string; message: string };

export class IngestRejected extends Error {
    constructor(readonly code: string, message: string) {
        super(message);
        this.name = 'IngestRejected';
    }
}

/** Parses the operation context the Gateway attached to a media session. */
export const ingestTargetFromContext = (
    context: Record<string, unknown> | undefined,
    mac: string,
    kind: 'live' | 'playback',
): IngestTarget | null => {
    const url = typeof context?.media_ingest_url === 'string' ? context.media_ingest_url : '';
    const token = typeof context?.media_ingest_token === 'string' ? context.media_ingest_token : '';
    const sessionId = typeof context?.resource_session_id === 'string' ? context.resource_session_id : '';
    if (!/^wss?:\/\//i.test(url) || !token || !/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
    return {
        url,
        token,
        sessionId,
        mac,
        kind,
        profileId: typeof context?.media_profile_id === 'string' ? context.media_profile_id : null,
    };
};

export class IngestConnection {
    private closed = false;
    private readonly closeListeners: Array<(reason: string) => void> = [];

    private constructor(
        private readonly socket: WebSocket,
        readonly target: IngestTarget,
        private readonly onMessage: (message: RelayMessage) => void,
    ) {}

    /** Opens the WebSocket, sends hello and resolves after the relay says ready. */
    static open(
        target: IngestTarget,
        onMessage: (message: RelayMessage) => void,
        timeoutMs = 8000,
    ): Promise<IngestConnection> {
        return new Promise((resolve, reject) => {
            let settled = false;
            const socket = new WebSocket(target.url);
            socket.binaryType = 'arraybuffer';
            const connection = new IngestConnection(socket, target, onMessage);
            const finish = (error?: Error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (error) {
                    connection.close('open_failed');
                    reject(error);
                } else {
                    resolve(connection);
                }
            };
            const timer = setTimeout(() => finish(new IngestRejected('MEDIA_INGEST_TIMEOUT', 'Media relay did not answer in time')), timeoutMs);
            socket.addEventListener('open', () => {
                socket.send(JSON.stringify({
                    type: 'hello',
                    protocol: INGEST_PROTOCOL,
                    session_id: target.sessionId,
                    ingest_token: target.token,
                    mac: target.mac,
                    kind: target.kind,
                    profile_id: target.profileId ?? undefined,
                }));
            });
            socket.addEventListener('message', (event) => {
                if (typeof event.data !== 'string') return;
                let message: RelayMessage;
                try {
                    message = JSON.parse(event.data) as RelayMessage;
                } catch {
                    return;
                }
                if (!settled) {
                    if (message.type === 'ready') finish();
                    else if (message.type === 'error') finish(new IngestRejected(message.code, message.message));
                    return;
                }
                onMessage(message);
            });
            socket.addEventListener('error', () => finish(new IngestRejected('MEDIA_INGEST_FAILED', 'Could not connect to the media relay')));
            socket.addEventListener('close', (event) => {
                finish(new IngestRejected('MEDIA_INGEST_FAILED', `Media relay closed the connection (${event.code})`));
                connection.markClosed(event.reason || `closed_${event.code}`);
            });
        });
    }

    get isOpen(): boolean {
        return !this.closed && this.socket.readyState === WebSocket.OPEN;
    }

    /** Bytes queued in the socket; used to drop live fragments instead of buffering forever. */
    get bufferedAmount(): number {
        return this.socket.bufferedAmount;
    }

    onClose(listener: (reason: string) => void): void {
        if (this.closed) listener('closed');
        else this.closeListeners.push(listener);
    }

    sendJson(message: object): void {
        if (this.isOpen) this.socket.send(JSON.stringify(message));
    }

    sendFrame(type: number, payload: Uint8Array, requestId?: number): void {
        if (!this.isOpen) return;
        const header = requestId === undefined ? 1 : 5;
        const frame = new Uint8Array(header + payload.byteLength);
        frame[0] = type;
        if (requestId !== undefined) new DataView(frame.buffer).setUint32(1, requestId);
        frame.set(payload, header);
        this.socket.send(frame);
    }

    close(reason = 'closed'): void {
        if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
            try {
                if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'end', reason }));
                this.socket.close(1000, reason.slice(0, 100));
            } catch {
                // already closing
            }
        }
        this.markClosed(reason);
    }

    private markClosed(reason: string): void {
        if (this.closed) return;
        this.closed = true;
        for (const listener of this.closeListeners.splice(0)) listener(reason);
    }
}
