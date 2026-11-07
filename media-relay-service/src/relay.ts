import http from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { SESSION_ID, SessionAuthorizer, type AuthFailure } from './auth';
import { isInitSegment } from './fmp4';
import { LiveChannel, type IngestPeer } from './live';
import { PlaybackChannel } from './playback';
import {
    FRAME_FETCH_DATA,
    FRAME_FRAGMENT,
    FRAME_INIT,
    INGEST_PROTOCOL,
    type CameraMessage,
    type RelayMessage,
} from './protocol';

export interface RelayOptions {
    authorizer: SessionAuthorizer;
    log?: (level: 'info' | 'warn', message: string, data?: Record<string, unknown>) => void;
    now?: () => number;
    liveWindowFragments?: number;
    /** No HLS request from any viewer for this long: ask the camera to stop. */
    liveIdleStopMs?: number;
    /** Grace period after an ingest starts before idle stop applies. */
    liveStartGraceMs?: number;
    playbackIdleStopMs?: number;
    firstFragmentWaitMs?: number;
    helloTimeoutMs?: number;
    sweepIntervalMs?: number;
}

const MAX_INGEST_MESSAGE_BYTES = 16 * 1024 * 1024;

const HLS_ROUTE = /^\/v1\/sessions\/([0-9a-fA-F-]{36})\/([A-Za-z0-9_-]{20,128})\/(index\.m3u8|live\/init-(\d+)\.mp4|live\/(\d+)\.m4s|rec\/([A-Za-z0-9_-]{1,64})\/(init\.mp4|media\.m4s))$/;

/**
 * Media relay core (contract 6.1): only forwards and packages HLS. It keeps
 * about 30 s of live fragments in RAM per camera, never stores recordings and
 * never transcodes.
 */
export class MediaRelay {
    readonly server: http.Server;
    private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_INGEST_MESSAGE_BYTES });
    private readonly live = new Map<string, LiveChannel>();
    private readonly playback = new Map<string, PlaybackChannel>();
    private readonly now: () => number;
    private readonly sweeper: NodeJS.Timeout;
    private readonly opts: Required<Omit<RelayOptions, 'authorizer' | 'log' | 'now'>>;

    constructor(private readonly options: RelayOptions) {
        this.now = options.now || Date.now;
        this.opts = {
            liveWindowFragments: options.liveWindowFragments ?? 15,
            liveIdleStopMs: options.liveIdleStopMs ?? 15_000,
            liveStartGraceMs: options.liveStartGraceMs ?? 25_000,
            playbackIdleStopMs: options.playbackIdleStopMs ?? 90_000,
            firstFragmentWaitMs: options.firstFragmentWaitMs ?? 10_000,
            helloTimeoutMs: options.helloTimeoutMs ?? 5000,
            sweepIntervalMs: options.sweepIntervalMs ?? 2000,
        };
        this.server = http.createServer((request, response) => {
            void this.handleHttp(request, response).catch((error) => {
                this.log('warn', 'HLS request failed', { error: error instanceof Error ? error.message : String(error) });
                if (!response.headersSent) this.reply(response, 500, 'Internal relay error');
                else response.destroy();
            });
        });
        this.server.on('upgrade', (request, socket, head) => this.handleUpgrade(request, socket, head));
        this.sweeper = setInterval(() => void this.sweep(), this.opts.sweepIntervalMs);
        this.sweeper.unref();
    }

    async close(): Promise<void> {
        clearInterval(this.sweeper);
        for (const client of this.wss.clients) client.terminate();
        await new Promise<void>((resolve) => this.server.close(() => resolve()));
    }

    /** Gateway revoked sessions (unpair, viewer closed, membership revoked). */
    revoke(sessionIds: string[]): void {
        this.options.authorizer.revoke(sessionIds);
        for (const channel of this.live.values()) channel.forget(sessionIds);
        for (const id of sessionIds) {
            const channel = this.playback.get(id);
            if (channel) this.stopPlayback(channel, 'session_revoked');
        }
    }

    stats() {
        return {
            live_cameras: [...this.live.values()].filter((channel) => channel.peer).length,
            playback_sessions: this.playback.size,
        };
    }

    private log(level: 'info' | 'warn', message: string, data?: Record<string, unknown>) {
        this.options.log?.(level, message, data);
    }

    // ---------------------------------------------------------------- ingest

    private handleUpgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer) {
        const path = (request.url || '').split('?')[0];
        if (path !== '/v1/ingest') {
            socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
        }
        this.wss.handleUpgrade(request, socket, head, (ws) => this.onIngest(ws));
    }

    private onIngest(ws: WebSocket) {
        const peer: IngestPeer = {
            send: (message: RelayMessage | object) => {
                if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
            },
            close: (code = 1000, reason = '') => {
                if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(code, reason);
            },
        };
        let role: { kind: 'live'; channel: LiveChannel } | { kind: 'playback'; channel: PlaybackChannel } | null = null;
        let authorizing = false;
        const helloTimer = setTimeout(() => {
            if (!role) peer.close(4008, 'hello timeout');
        }, this.opts.helloTimeoutMs);

        const fail = (code: string, message: string) => {
            peer.send({ type: 'error', code, message });
            peer.close(4003, code);
        };

        ws.on('message', (raw: RawData, isBinary: boolean) => {
            const data = toBytes(raw);
            if (!isBinary) {
                let message: CameraMessage;
                try {
                    message = JSON.parse(Buffer.from(data).toString('utf8'));
                } catch {
                    fail('BAD_MESSAGE', 'Control messages must be JSON');
                    return;
                }
                if (message.type === 'hello') {
                    if (role || authorizing) return;
                    authorizing = true;
                    void this.acceptHello(message, peer).then((accepted) => {
                        clearTimeout(helloTimer);
                        if (!accepted) return;
                        role = accepted;
                    }).catch((error) => fail('INGEST_ERROR', error instanceof Error ? error.message : 'ingest error'));
                    return;
                }
                if (!role) return;
                if (role.kind === 'playback') {
                    const channel = role.channel;
                    if (message.type === 'segment_list' && Array.isArray(message.segments)) channel.setSegments(message.segments.slice(0, 2000));
                    else if (message.type === 'fetch_done') channel.onDone(Number(message.request_id));
                    else if (message.type === 'fetch_error') channel.onError(Number(message.request_id), String(message.reason || 'fetch_failed'));
                }
                if (message.type === 'end') peer.close(1000, 'camera ended');
                return;
            }
            if (!role || data.byteLength < 2) return;
            const type = data[0];
            const payload = data.subarray(1);
            if (role.kind === 'live') {
                if (type === FRAME_INIT && isInitSegment(payload)) role.channel.onInit(payload);
                else if (type === FRAME_FRAGMENT) role.channel.onFragment(payload);
            } else if (type === FRAME_FETCH_DATA && payload.byteLength >= 4) {
                const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
                role.channel.onData(view.getUint32(0), payload.subarray(4));
            }
        });

        ws.on('close', () => {
            clearTimeout(helloTimer);
            if (!role) return;
            if (role.kind === 'live') {
                if (role.channel.peer === peer) role.channel.clearMedia();
                role.channel.detach(peer);
                this.log('info', 'Live ingest closed', { mac: role.channel.mac });
            } else {
                role.channel.failAll('ingest_closed');
                if (this.playback.get(role.channel.sessionId) === role.channel) this.playback.delete(role.channel.sessionId);
                this.log('info', 'Playback ingest closed', { mac: role.channel.mac });
            }
        });
        ws.on('error', () => undefined);
    }

    private async acceptHello(
        hello: Extract<CameraMessage, { type: 'hello' }>,
        peer: IngestPeer,
    ): Promise<{ kind: 'live'; channel: LiveChannel } | { kind: 'playback'; channel: PlaybackChannel } | null> {
        const refuse = (code: string, message: string) => {
            peer.send({ type: 'error', code, message });
            peer.close(4003, code);
            return null;
        };
        if (hello.protocol !== INGEST_PROTOCOL) return refuse('PROTOCOL_UNSUPPORTED', 'Unsupported ingest protocol');
        if (hello.kind !== 'live' && hello.kind !== 'playback') return refuse('BAD_HELLO', 'kind must be live or playback');
        const sessionId = String(hello.session_id || '');
        const mac = String(hello.mac || '').toUpperCase();
        if (!SESSION_ID.test(sessionId) || !/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) return refuse('BAD_HELLO', 'Invalid session or MAC');
        const auth = await this.options.authorizer.authorizeIngest(sessionId, String(hello.ingest_token || ''), mac);
        if (!auth.ok) return refuse('INGEST_FORBIDDEN', describe(auth.reason));
        if (hello.kind === 'live') {
            let channel = this.live.get(mac);
            if (!channel) {
                channel = new LiveChannel(mac, { windowFragments: this.opts.liveWindowFragments, now: this.now });
                this.live.set(mac, channel);
            }
            channel.attach(peer);
            channel.clearMedia();
            peer.send({ type: 'ready', session_id: sessionId });
            this.log('info', 'Live ingest started', { mac });
            return { kind: 'live', channel };
        }
        const existing = this.playback.get(sessionId);
        if (existing) existing.peer.close(4001, 'replaced by a newer ingest');
        const channel = new PlaybackChannel(sessionId, mac, peer, this.now);
        this.playback.set(sessionId, channel);
        peer.send({ type: 'ready', session_id: sessionId });
        this.log('info', 'Playback ingest started', { mac });
        return { kind: 'playback', channel };
    }

    private stopPlayback(channel: PlaybackChannel, reason: string) {
        channel.peer.send({ type: 'stop', reason });
        channel.failAll(reason);
        channel.peer.close(1000, reason);
        this.playback.delete(channel.sessionId);
    }

    private async sweep() {
        const now = this.now();
        for (const [mac, channel] of this.live) {
            channel.publishViewerCount(10_000);
            if (channel.peer) {
                const sinceViewer = now - Math.max(channel.lastViewerAt, channel.peerAttachedAt);
                const sinceStart = now - channel.peerAttachedAt;
                if (sinceStart > this.opts.liveStartGraceMs && sinceViewer > this.opts.liveIdleStopMs) {
                    channel.peer.send({ type: 'stop', reason: 'no_viewers' });
                    channel.peer.close(1000, 'no viewers');
                    channel.peer = null;
                    channel.clearMedia();
                    this.log('info', 'Stopped live ingest without viewers', { mac });
                }
            } else if (now - channel.lastViewerAt > 60_000) {
                this.live.delete(mac);
            }
        }
        for (const channel of [...this.playback.values()]) {
            if (now - channel.lastActivityAt > this.opts.playbackIdleStopMs) {
                this.stopPlayback(channel, 'idle');
                continue;
            }
            const projection = await this.options.authorizer.load(channel.sessionId).catch(() => undefined);
            if (projection === null || (projection && Date.parse(projection.expires_at) <= now)) {
                this.stopPlayback(channel, 'session_expired');
            }
        }
    }

    // ------------------------------------------------------------------ HLS

    private async handleHttp(request: http.IncomingMessage, response: http.ServerResponse) {
        response.setHeader('Access-Control-Allow-Origin', '*');
        const path = (request.url || '').split('?')[0];
        if (path === '/health') {
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ status: 'ok', service: 'media-relay-service', ...this.stats() }));
            return;
        }
        if (request.method === 'OPTIONS') {
            response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
            response.writeHead(204).end();
            return;
        }
        if (request.method !== 'GET' && request.method !== 'HEAD') return this.reply(response, 405, 'Method not allowed');
        const match = HLS_ROUTE.exec(path);
        if (!match) return this.reply(response, 404, 'Not found');
        const [, sessionId, token, resource, initVersion, liveSeq, recId, recPart] = match;
        const auth = await this.options.authorizer.authorizeViewer(sessionId, token);
        if (!auth.ok) {
            if (auth.reason === 'not_ready') {
                response.setHeader('Retry-After', '1');
                return this.reply(response, 503, 'Session is not ready yet');
            }
            return this.reply(response, 403, 'Session is not valid');
        }
        response.setHeader('Cache-Control', 'no-store');
        const playback = this.playback.get(sessionId);
        if (playback) {
            if (playback.mac !== auth.projection!.device_mac.toUpperCase()) return this.reply(response, 403, 'Session is not valid');
            return this.servePlayback(playback, resource, recId, recPart, request, response);
        }
        if (recId) return this.reply(response, 404, 'Playback is not active');
        const channel = this.live.get(auth.projection!.device_mac.toUpperCase());
        if (!channel) return this.reply(response, 404, 'Camera is not streaming');
        channel.touch(sessionId);
        if (resource === 'index.m3u8') {
            if (channel.fragmentCount < 2) await channel.waitForFragments(2, this.opts.firstFragmentWaitMs);
            const playlist = channel.playlist();
            if (!playlist) return this.reply(response, 503, 'Camera has not sent video yet');
            return this.send(response, 'application/vnd.apple.mpegurl', Buffer.from(playlist), request);
        }
        if (initVersion) {
            const init = channel.init(Number(initVersion));
            return init ? this.send(response, 'video/mp4', init, request) : this.reply(response, 404, 'Init segment expired');
        }
        const fragment = channel.fragment(Number(liveSeq));
        return fragment ? this.send(response, 'video/iso.segment', fragment, request) : this.reply(response, 404, 'Fragment expired');
    }

    private async servePlayback(
        channel: PlaybackChannel,
        resource: string,
        recId: string | undefined,
        recPart: string | undefined,
        request: http.IncomingMessage,
        response: http.ServerResponse,
    ) {
        channel.lastActivityAt = this.now();
        if (resource === 'index.m3u8') {
            await channel.waitForSegments(this.opts.firstFragmentWaitMs);
            const playlist = channel.playlist();
            if (!playlist) return this.reply(response, 503, 'Camera has not listed recordings yet');
            return this.send(response, 'application/vnd.apple.mpegurl', Buffer.from(playlist), request);
        }
        const segment = recId ? channel.segment(recId) : undefined;
        if (!segment) return this.reply(response, 404, 'Recording not found');
        if (recPart === 'init.mp4') {
            try {
                return this.send(response, 'video/mp4', await channel.fetchInit(segment), request);
            } catch {
                return this.reply(response, 404, 'Recording is no longer available');
            }
        }
        const length = segment.size - segment.init_length;
        response.setHeader('Content-Type', 'video/iso.segment');
        if (request.method === 'HEAD') {
            response.setHeader('Content-Length', String(length));
            response.end();
            return;
        }
        const stream = channel.fetch(segment.id, segment.init_length, null);
        let started = false;
        stream.once('data', () => {
            started = true;
        });
        stream.on('error', () => {
            if (!started && !response.headersSent) this.reply(response, 404, 'Recording is no longer available');
            else response.destroy();
        });
        response.on('close', () => {
            if (!stream.destroyed) stream.destroy();
        });
        stream.once('readable', () => {
            if (!response.headersSent) {
                response.setHeader('Content-Length', String(length));
                response.writeHead(200);
            }
        });
        stream.pipe(response);
    }

    private send(response: http.ServerResponse, type: string, body: Uint8Array, request: http.IncomingMessage) {
        response.setHeader('Content-Type', type);
        response.setHeader('Content-Length', String(body.byteLength));
        if (request.method === 'HEAD') response.end();
        else response.end(Buffer.from(body.buffer, body.byteOffset, body.byteLength));
    }

    private reply(response: http.ServerResponse, status: number, message: string) {
        response.statusCode = status;
        response.setHeader('Content-Type', 'text/plain; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        response.end(message);
    }
}

const toBytes = (raw: RawData): Uint8Array => {
    if (Buffer.isBuffer(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    if (Array.isArray(raw)) return new Uint8Array(Buffer.concat(raw));
    return new Uint8Array(raw as ArrayBuffer);
};

const describe = (reason?: AuthFailure) => ({
    not_found: 'Session not found',
    expired: 'Session expired',
    forbidden: 'Token rejected',
    not_ready: 'Session not ready',
    wrong_kind: 'Not a media session',
}[reason || 'forbidden']);
