import { readFragmentInfo } from './fmp4';

/** Something the relay can talk back to (one camera ingest connection). */
export interface IngestPeer {
    send(message: object): void;
    close(code?: number, reason?: string): void;
}

interface LiveFragment {
    seq: number;
    data: Uint8Array;
    duration: number;
    initVersion: number;
    receivedAt: number;
}

export interface LiveOptions {
    /** Fragments kept in memory (about 2 s each). */
    windowFragments: number;
    now: () => number;
}

/**
 * Live state of one camera: the latest init segment and a short window of
 * fragments shared by all viewers of that camera (contract 6.1: one live
 * ingest per camera, at most five viewers).
 */
export class LiveChannel {
    peer: IngestPeer | null = null;
    peerAttachedAt = 0;
    lastViewerAt = 0;
    private readonly inits = new Map<number, Uint8Array>();
    private initVersion = 0;
    private fragments: LiveFragment[] = [];
    private nextSeq = 0;
    private discontinuitySequence = 0;
    private readonly viewers = new Map<string, number>();
    private waiters: Array<() => void> = [];
    private lastViewerCount = -1;

    constructor(readonly mac: string, private readonly options: LiveOptions) {}

    attach(peer: IngestPeer): void {
        if (this.peer && this.peer !== peer) this.peer.close(4001, 'replaced by a newer ingest');
        this.peer = peer;
        this.peerAttachedAt = this.options.now();
        this.lastViewerCount = -1;
    }

    detach(peer: IngestPeer): void {
        if (this.peer === peer) this.peer = null;
    }

    onInit(data: Uint8Array): void {
        const current = this.inits.get(this.initVersion);
        if (current && Buffer.from(current).equals(Buffer.from(data))) return;
        this.initVersion += 1;
        this.inits.set(this.initVersion, data);
    }

    onFragment(data: Uint8Array): boolean {
        if (this.initVersion === 0) return false;
        const info = readFragmentInfo(data);
        if (!info || info.durationSeconds <= 0) return false;
        this.fragments.push({
            seq: this.nextSeq++,
            data,
            duration: info.durationSeconds,
            initVersion: this.initVersion,
            receivedAt: this.options.now(),
        });
        while (this.fragments.length > this.options.windowFragments) {
            const removed = this.fragments.shift()!;
            if (this.fragments[0] && this.fragments[0].initVersion !== removed.initVersion) {
                this.discontinuitySequence += 1;
            }
        }
        const used = new Set(this.fragments.map((fragment) => fragment.initVersion));
        for (const version of [...this.inits.keys()]) {
            if (version !== this.initVersion && !used.has(version)) this.inits.delete(version);
        }
        const waiters = this.waiters;
        this.waiters = [];
        for (const wake of waiters) wake();
        return true;
    }

    get fragmentCount(): number {
        return this.fragments.length;
    }

    /** Waits until at least `count` fragments exist (first viewer of a fresh ingest). */
    async waitForFragments(count: number, timeoutMs: number): Promise<boolean> {
        const deadline = this.options.now() + timeoutMs;
        while (this.fragments.length < count) {
            const remaining = deadline - this.options.now();
            if (remaining <= 0) return false;
            await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, Math.min(remaining, 500));
                this.waiters.push(() => {
                    clearTimeout(timer);
                    resolve();
                });
            });
        }
        return true;
    }

    init(version: number): Uint8Array | undefined {
        return this.inits.get(version);
    }

    fragment(seq: number): Uint8Array | undefined {
        return this.fragments.find((fragment) => fragment.seq === seq)?.data;
    }

    playlist(): string | null {
        if (this.fragments.length === 0) return null;
        const target = Math.max(1, Math.ceil(Math.max(...this.fragments.map((fragment) => fragment.duration))));
        const lines = [
            '#EXTM3U',
            '#EXT-X-VERSION:7',
            `#EXT-X-TARGETDURATION:${target}`,
            `#EXT-X-MEDIA-SEQUENCE:${this.fragments[0].seq}`,
            `#EXT-X-DISCONTINUITY-SEQUENCE:${this.discontinuitySequence}`,
            '#EXT-X-INDEPENDENT-SEGMENTS',
        ];
        let version = -1;
        for (const fragment of this.fragments) {
            if (fragment.initVersion !== version) {
                if (version !== -1) lines.push('#EXT-X-DISCONTINUITY');
                lines.push(`#EXT-X-MAP:URI="live/init-${fragment.initVersion}.mp4"`);
                version = fragment.initVersion;
            }
            lines.push(`#EXTINF:${fragment.duration.toFixed(3)},`, `live/${fragment.seq}.m4s`);
        }
        return `${lines.join('\n')}\n`;
    }

    touch(sessionId: string): void {
        const now = this.options.now();
        this.viewers.set(sessionId, now);
        this.lastViewerAt = now;
    }

    forget(sessionIds: string[]): void {
        for (const id of sessionIds) this.viewers.delete(id);
    }

    /** Viewers that requested anything recently; tells the camera when it changes. */
    publishViewerCount(windowMs: number): number {
        const now = this.options.now();
        for (const [id, seen] of this.viewers) if (now - seen > windowMs) this.viewers.delete(id);
        const count = Math.min(this.viewers.size, 5);
        if (this.peer && count !== this.lastViewerCount) {
            this.peer.send({ type: 'viewers', count });
            this.lastViewerCount = count;
        }
        return count;
    }

    clearMedia(): void {
        this.fragments = [];
        this.inits.clear();
        this.initVersion = 0;
    }
}
