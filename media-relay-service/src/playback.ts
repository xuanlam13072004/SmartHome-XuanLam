import { PassThrough } from 'node:stream';
import type { IngestPeer } from './live';
import type { RecordingSegmentInfo } from './protocol';

interface PendingFetch {
    stream: PassThrough;
    received: number;
}

/**
 * One playback session: the camera announced its 1-minute files for the
 * requested range; the relay builds a VOD playlist and fetches each file from
 * the camera when the player asks for it (contract 7.2).
 */
export class PlaybackChannel {
    segments: RecordingSegmentInfo[] | null = null;
    lastActivityAt: number;
    private readonly pending = new Map<number, PendingFetch>();
    private readonly inits = new Map<string, Uint8Array>();
    private nextRequestId = 1;
    private listWaiters: Array<() => void> = [];

    constructor(
        readonly sessionId: string,
        readonly mac: string,
        readonly peer: IngestPeer,
        private readonly now: () => number,
    ) {
        this.lastActivityAt = now();
    }

    setSegments(segments: RecordingSegmentInfo[]): void {
        this.segments = segments
            .filter((segment) => Number.isFinite(Date.parse(segment.start)) && Number.isFinite(Date.parse(segment.end)))
            .filter((segment) => segment.size > segment.init_length && segment.init_length > 0)
            .sort((left, right) => Date.parse(left.start) - Date.parse(right.start));
        const waiters = this.listWaiters;
        this.listWaiters = [];
        for (const wake of waiters) wake();
    }

    async waitForSegments(timeoutMs: number): Promise<boolean> {
        if (this.segments) return true;
        await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, timeoutMs);
            this.listWaiters.push(() => {
                clearTimeout(timer);
                resolve();
            });
        });
        return this.segments !== null;
    }

    segment(id: string): RecordingSegmentInfo | undefined {
        return this.segments?.find((segment) => segment.id === id);
    }

    playlist(): string | null {
        if (!this.segments) return null;
        const durations = this.segments.map((segment) => (Date.parse(segment.end) - Date.parse(segment.start)) / 1000);
        const lines = [
            '#EXTM3U',
            '#EXT-X-VERSION:7',
            '#EXT-X-PLAYLIST-TYPE:VOD',
            `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(Math.max(1, ...durations)))}`,
            '#EXT-X-MEDIA-SEQUENCE:0',
            '#EXT-X-INDEPENDENT-SEGMENTS',
        ];
        let initId: string | null = null;
        let previousEnd: number | null = null;
        this.segments.forEach((segment, index) => {
            const start = Date.parse(segment.start);
            const gap = previousEnd !== null && start - previousEnd > 3000;
            if (segment.init_id !== initId || gap) {
                if (initId !== null) lines.push('#EXT-X-DISCONTINUITY');
                lines.push(`#EXT-X-MAP:URI="rec/${encodeURIComponent(segment.id)}/init.mp4"`);
                initId = segment.init_id;
            }
            lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(start).toISOString()}`);
            lines.push(`#EXTINF:${Math.max(0.001, durations[index]).toFixed(3)},`);
            lines.push(`rec/${encodeURIComponent(segment.id)}/media.m4s`);
            previousEnd = Date.parse(segment.end);
        });
        lines.push('#EXT-X-ENDLIST');
        return `${lines.join('\n')}\n`;
    }

    /** Streams a byte range of a recording file from the camera. */
    fetch(segmentId: string, offset: number, length: number | null): PassThrough {
        this.lastActivityAt = this.now();
        const requestId = this.nextRequestId++;
        const stream = new PassThrough();
        this.pending.set(requestId, { stream, received: 0 });
        stream.on('close', () => {
            if (this.pending.delete(requestId)) this.peer.send({ type: 'cancel_fetch', request_id: requestId });
        });
        this.peer.send({ type: 'fetch', request_id: requestId, segment_id: segmentId, offset, length });
        return stream;
    }

    async fetchInit(segment: RecordingSegmentInfo): Promise<Uint8Array> {
        const cached = this.inits.get(segment.init_id);
        if (cached) return cached;
        const chunks: Buffer[] = [];
        const stream = this.fetch(segment.id, 0, segment.init_length);
        await new Promise<void>((resolve, reject) => {
            stream.on('data', (chunk: Buffer) => chunks.push(chunk));
            stream.on('end', resolve);
            stream.on('error', reject);
        });
        const init = new Uint8Array(Buffer.concat(chunks));
        if (init.byteLength !== segment.init_length) throw new Error('Incomplete init segment');
        this.inits.set(segment.init_id, init);
        return init;
    }

    onData(requestId: number, data: Uint8Array): void {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        pending.received += data.byteLength;
        this.lastActivityAt = this.now();
        pending.stream.write(Buffer.from(data));
    }

    onDone(requestId: number): void {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        pending.stream.end();
    }

    onError(requestId: number, reason: string): void {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        pending.stream.destroy(Object.assign(new Error(reason), { code: reason }));
    }

    failAll(reason: string): void {
        for (const id of [...this.pending.keys()]) this.onError(id, reason);
    }
}
