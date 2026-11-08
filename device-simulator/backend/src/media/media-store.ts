import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readVideoFragmentTiming, VIDEO_TIMESCALE } from './fmp4';

/**
 * Virtual SD-card storage for all virtual cameras of this Simulator
 * (docs/architecture/camera-contract.md, sections 7.3–7.5 and 9).
 *
 * Layout: <root>/<run_id>/<MAC without separators>/<storage_generation>/<YYYYMMDD>/<HHMMSS>.mp4
 * The directory tree is the source of truth; the in-memory index is rebuilt
 * from it at startup. A whole-store quota applies: when it is exceeded the
 * oldest completed segment of any camera is recycled. A segment that is still
 * being written is never deleted.
 */

export interface SegmentInfo {
    /** `<YYYYMMDD>-<HHMMSS>`, unique within one camera generation. */
    id: string;
    runId: string;
    macKey: string;
    generation: string;
    path: string;
    startMs: number;
    endMs: number;
    size: number;
}

export interface CameraUsage {
    usedBytes: number;
    oldestMs: number | null;
    newestMs: number | null;
    segments: number;
}

export interface StorageChange {
    reason: 'recycled' | 'deleted' | 'wiped';
    deletedSegments: number;
    freedBytes: number;
}

type CameraListener = (change: StorageChange) => void;

interface CameraEntry {
    runId: string;
    macKey: string;
    generations: Set<string>;
    segments: SegmentInfo[];
    activeBytes: number;
}

const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,96}$/;
const SEGMENT_FILE = /^(\d{6})\.mp4$/;
const PART_FILE = /^(\d{6})\.mp4\.part$/;
const DATE_DIR = /^\d{8}$/;

export const macKey = (mac: string): string => {
    const key = mac.replace(/[^0-9a-f]/gi, '').toUpperCase();
    if (key.length !== 12) throw new Error('Camera MAC address is invalid');
    return key;
};

const assertSafe = (value: string, label: string) => {
    if (!SAFE_SEGMENT.test(value)) throw new Error(`${label} is not a safe storage path segment`);
    return value;
};

const pad = (value: number, length = 2) => String(value).padStart(length, '0');

export const segmentNameParts = (startMs: number) => {
    const date = new Date(startMs);
    return {
        day: `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`,
        time: `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`,
    };
};

const parseSegmentStart = (day: string, time: string): number => Date.UTC(
    Number(day.slice(0, 4)), Number(day.slice(4, 6)) - 1, Number(day.slice(6, 8)),
    Number(time.slice(0, 2)), Number(time.slice(2, 4)), Number(time.slice(4, 6)),
);

const exists = (target: string) => fs.access(target).then(() => true, () => false);

/** Reads only box headers plus the first and last moof of a recording file. */
export const inspectRecordingFile = async (filePath: string): Promise<{
    validLength: number;
    fragments: number;
    durationSeconds: number;
    size: number;
}> => {
    const handle = await fs.open(filePath, 'r');
    try {
        const { size } = await handle.stat();
        const header = Buffer.alloc(16);
        const moofs: Array<{ offset: number; size: number }> = [];
        let offset = 0;
        let validLength = 0;
        let sawMoov = false;
        let pendingMoof: { offset: number; size: number } | null = null;
        while (offset + 8 <= size) {
            const { bytesRead } = await handle.read(header, 0, 16, offset);
            if (bytesRead < 8) break;
            let boxSize = header.readUInt32BE(0);
            const type = header.toString('latin1', 4, 8);
            if (boxSize === 1) {
                if (bytesRead < 16) break;
                boxSize = Number(header.readBigUInt64BE(8));
            }
            if (boxSize < 8 || offset + boxSize > size || !/^[\x20-\x7e]{4}$/.test(type)) break;
            if (type === 'moov') {
                sawMoov = true;
                validLength = offset + boxSize;
            } else if (type === 'moof' && sawMoov) {
                pendingMoof = { offset, size: boxSize };
            } else if (type === 'mdat' && pendingMoof) {
                moofs.push(pendingMoof);
                pendingMoof = null;
                validLength = offset + boxSize;
            }
            offset += boxSize;
        }
        const timing = async (moof: { offset: number; size: number }) => {
            const data = Buffer.alloc(moof.size);
            await handle.read(data, 0, moof.size, moof.offset);
            return readVideoFragmentTiming(data, { type: 'moof', offset: 0, size: moof.size });
        };
        let durationSeconds = 0;
        if (moofs.length > 0) {
            const first = await timing(moofs[0]);
            const last = await timing(moofs[moofs.length - 1]);
            if (first && last) durationSeconds = Math.max(0, last.end - first.start) / VIDEO_TIMESCALE;
        }
        return {
            validLength: moofs.length > 0 ? validLength : 0,
            fragments: moofs.length,
            durationSeconds,
            size,
        };
    } finally {
        await handle.close();
    }
};

/** Length and identity of the init segment at the head of a recording file. */
export const readRecordingInit = async (filePath: string): Promise<{ initLength: number; initId: string }> => {
    const handle = await fs.open(filePath, 'r');
    try {
        const header = Buffer.alloc(8);
        let offset = 0;
        for (let index = 0; index < 4; index += 1) {
            const { bytesRead } = await handle.read(header, 0, 8, offset);
            if (bytesRead < 8) break;
            const size = header.readUInt32BE(0);
            const type = header.toString('latin1', 4, 8);
            if (size < 8) break;
            offset += size;
            if (type === 'moov') {
                const init = Buffer.alloc(offset);
                await handle.read(init, 0, offset, 0);
                const initId = createHash('sha1').update(init).digest('hex').slice(0, 16);
                return { initLength: offset, initId };
            }
        }
        throw new Error('Recording has no init segment');
    } finally {
        await handle.close();
    }
};

export class SegmentWriter {
    private closed = false;
    private queue: Promise<void> = Promise.resolve();
    bytes = 0;
    lastEndMs: number;

    constructor(
        private readonly store: MediaStore,
        private readonly entry: CameraEntry,
        readonly generation: string,
        readonly id: string,
        readonly partPath: string,
        readonly finalPath: string,
        readonly startMs: number,
        private readonly handle: fs.FileHandle,
    ) {
        this.lastEndMs = startMs;
    }

    get isClosed(): boolean {
        return this.closed;
    }

    /**
     * What is on disk so far, as a segment ending at the last whole fragment.
     * Lets playback and `list_recordings` include the minute being recorded;
     * the file keeps the same bytes after it is renamed on close.
     */
    snapshot(): SegmentInfo | null {
        if (this.closed || this.bytes === 0 || this.lastEndMs <= this.startMs) return null;
        return {
            id: this.id,
            runId: this.entry.runId,
            macKey: this.entry.macKey,
            generation: this.generation,
            path: this.partPath,
            startMs: this.startMs,
            endMs: this.lastEndMs,
            size: this.bytes,
        };
    }

    /** Appends bytes; writes are serialized in call order. */
    append(data: Uint8Array, endMs: number): Promise<void> {
        if (this.closed) return Promise.reject(new Error('Recording segment is already closed'));
        const task = this.queue.then(async () => {
            await this.handle.write(data);
            this.bytes += data.byteLength;
            this.lastEndMs = Math.max(this.lastEndMs, endMs);
            this.entry.activeBytes += data.byteLength;
            this.store.addBytes(data.byteLength);
            await this.store.enforceQuota();
        });
        this.queue = task.catch(() => undefined);
        return task;
    }

    async finalize(): Promise<SegmentInfo | null> {
        if (this.closed) return null;
        this.closed = true;
        await this.queue;
        await this.handle.close();
        this.entry.activeBytes -= this.bytes;
        this.store.releaseWriter(this);
        if (this.bytes === 0) {
            await fs.rm(this.partPath, { force: true });
            return null;
        }
        await fs.rename(this.partPath, this.finalPath);
        const info: SegmentInfo = {
            id: this.id,
            runId: this.entry.runId,
            macKey: this.entry.macKey,
            generation: this.generation,
            path: this.finalPath,
            startMs: this.startMs,
            endMs: Math.max(this.startMs, this.lastEndMs),
            size: this.bytes,
        };
        this.store.addSegment(this.entry, info);
        return info;
    }

    /** Drops an unfinished segment (used before a wipe). */
    async abort(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        await this.queue;
        await this.handle.close().catch(() => undefined);
        this.entry.activeBytes -= this.bytes;
        this.store.addBytes(-this.bytes);
        this.store.releaseWriter(this);
        await fs.rm(this.partPath, { force: true });
    }
}

export class MediaStore {
    private readonly cameras = new Map<string, CameraEntry>();
    private readonly writers = new Set<SegmentWriter>();
    private readonly listeners = new Map<string, CameraListener>();
    private totalBytes = 0;
    private initPromise: Promise<void> | null = null;
    private enforcing = false;

    constructor(
        readonly root: string,
        readonly quotaBytes: number,
        private readonly log: (message: string, data?: Record<string, unknown>) => void = () => undefined,
    ) {
        if (!Number.isSafeInteger(quotaBytes) || quotaBytes <= 0) {
            throw new Error('Media quota must be a positive integer');
        }
    }

    get usedBytes(): number {
        return this.totalBytes;
    }

    /** True while the store is at the quota and recycling old segments. */
    get recycling(): boolean {
        return this.totalBytes >= this.quotaBytes * 0.95;
    }

    init(): Promise<void> {
        this.initPromise ??= this.scan().catch((error) => {
            this.initPromise = null;
            throw error;
        });
        return this.initPromise;
    }

    static cameraKey(runId: string, mac: string): string {
        return `${runId}/${macKey(mac)}`;
    }

    setListener(runId: string, mac: string, listener: CameraListener | null): void {
        const key = MediaStore.cameraKey(runId, mac);
        if (listener) this.listeners.set(key, listener);
        else this.listeners.delete(key);
    }

    generations(runId: string, mac: string): string[] {
        return [...(this.cameras.get(MediaStore.cameraKey(runId, mac))?.generations || [])];
    }

    listSegments(runId: string, mac: string, generation?: string): SegmentInfo[] {
        const entry = this.cameras.get(MediaStore.cameraKey(runId, mac));
        if (!entry) return [];
        return entry.segments.filter((segment) => !generation || segment.generation === generation);
    }

    findSegment(runId: string, mac: string, id: string): SegmentInfo | undefined {
        return this.listSegments(runId, mac).find((segment) => segment.id === id);
    }

    usage(runId: string, mac: string, generation?: string): CameraUsage {
        const entry = this.cameras.get(MediaStore.cameraKey(runId, mac));
        const segments = entry ? this.listSegments(runId, mac, generation) : [];
        return {
            usedBytes: segments.reduce((sum, segment) => sum + segment.size, 0) + (entry?.activeBytes || 0),
            oldestMs: segments[0]?.startMs ?? null,
            newestMs: segments.length > 0 ? Math.max(...segments.map((segment) => segment.endMs)) : null,
            segments: segments.length,
        };
    }

    async openSegment(runId: string, mac: string, generation: string, startMs: number): Promise<SegmentWriter> {
        await this.init();
        const entry = this.entry(runId, mac);
        assertSafe(generation, 'Storage generation');
        entry.generations.add(generation);
        const { day } = segmentNameParts(startMs);
        const dir = path.join(this.root, entry.runId, entry.macKey, generation, day);
        await fs.mkdir(dir, { recursive: true });
        // Two sources started within one second must not overwrite each other.
        let nameMs = startMs;
        for (let attempt = 0; attempt < 10; attempt += 1, nameMs += 1000) {
            const { day: nameDay, time } = segmentNameParts(nameMs);
            if (nameDay !== day) break;
            const finalPath = path.join(dir, `${time}.mp4`);
            const partPath = `${finalPath}.part`;
            if (await exists(finalPath) || await exists(partPath)) continue;
            const handle = await fs.open(partPath, 'wx');
            const writer = new SegmentWriter(
                this, entry, generation, `${day}-${time}`, partPath, finalPath, startMs, handle,
            );
            this.writers.add(writer);
            return writer;
        }
        throw new Error('No free recording file name for this second');
    }

    /** Deletes completed segments of one generation matching a predicate. */
    async deleteSegments(
        runId: string,
        mac: string,
        generation: string,
        predicate: (segment: SegmentInfo) => boolean,
    ): Promise<StorageChange> {
        const entry = this.cameras.get(MediaStore.cameraKey(runId, mac));
        if (!entry) return { reason: 'deleted', deletedSegments: 0, freedBytes: 0 };
        const victims = entry.segments.filter((segment) => segment.generation === generation && predicate(segment));
        let freed = 0;
        for (const segment of victims) freed += await this.removeSegment(entry, segment);
        return { reason: 'deleted', deletedSegments: victims.length, freedBytes: freed };
    }

    /**
     * Removes every recording of a camera except those of `keepGeneration`.
     * Callers must finish or abort their open writers first.
     */
    async wipeCamera(runId: string, mac: string, keepGeneration?: string): Promise<StorageChange> {
        await this.init();
        const key = MediaStore.cameraKey(runId, mac);
        const entry = this.cameras.get(key);
        const cameraDir = path.join(this.root, assertSafe(runId, 'Run id'), macKey(mac));
        let deleted = 0;
        let freed = 0;
        if (entry) {
            for (const writer of [...this.writers]) {
                if (writer.isClosed) continue;
                if (writer.partPath.startsWith(cameraDir + path.sep) && writer.generation !== keepGeneration) {
                    await writer.abort();
                }
            }
            for (const segment of entry.segments.filter((item) => item.generation !== keepGeneration)) {
                freed += await this.removeSegment(entry, segment);
                deleted += 1;
            }
        }
        const generationDirs = await fs.readdir(cameraDir).catch(() => [] as string[]);
        for (const generation of generationDirs) {
            if (generation === keepGeneration) continue;
            await fs.rm(path.join(cameraDir, generation), { recursive: true, force: true });
            entry?.generations.delete(generation);
        }
        if (!keepGeneration) {
            await fs.rm(cameraDir, { recursive: true, force: true });
            await this.removeEmptyRunDir(runId);
            if (entry && entry.activeBytes === 0) this.cameras.delete(key);
        }
        return { reason: 'wiped', deletedSegments: deleted, freedBytes: freed };
    }

    async removeEmptyRunDir(runId: string): Promise<void> {
        const runDir = path.join(this.root, assertSafe(runId, 'Run id'));
        const children = await fs.readdir(runDir).catch(() => null);
        if (children && children.length === 0) await fs.rm(runDir, { recursive: true, force: true });
    }

    /** @internal */
    addBytes(delta: number): void {
        this.totalBytes = Math.max(0, this.totalBytes + delta);
    }

    /** @internal */
    releaseWriter(writer: SegmentWriter): void {
        this.writers.delete(writer);
    }

    /** @internal */
    addSegment(entry: CameraEntry, info: SegmentInfo): void {
        entry.segments.push(info);
        entry.segments.sort((left, right) => left.startMs - right.startMs);
    }

    /** Recycles the oldest completed segments of the whole store until it fits. */
    async enforceQuota(): Promise<void> {
        if (this.enforcing) return;
        this.enforcing = true;
        try {
            const changes = new Map<string, StorageChange>();
            while (this.totalBytes > this.quotaBytes) {
                let oldest: { entry: CameraEntry; segment: SegmentInfo } | null = null;
                for (const entry of this.cameras.values()) {
                    const candidate = entry.segments[0];
                    if (candidate && (!oldest || candidate.startMs < oldest.segment.startMs)) {
                        oldest = { entry, segment: candidate };
                    }
                }
                if (!oldest) break; // only segments being written remain
                const freed = await this.removeSegment(oldest.entry, oldest.segment);
                const key = `${oldest.entry.runId}/${oldest.entry.macKey}`;
                const change = changes.get(key) || { reason: 'recycled' as const, deletedSegments: 0, freedBytes: 0 };
                change.deletedSegments += 1;
                change.freedBytes += freed;
                changes.set(key, change);
            }
            for (const [key, change] of changes) {
                this.log('Recycled oldest recordings to stay within the media quota', { camera: key, ...change });
                this.listeners.get(key)?.(change);
            }
        } finally {
            this.enforcing = false;
        }
    }

    private entry(runId: string, mac: string): CameraEntry {
        const key = MediaStore.cameraKey(assertSafe(runId, 'Run id'), mac);
        let entry = this.cameras.get(key);
        if (!entry) {
            entry = { runId, macKey: macKey(mac), generations: new Set(), segments: [], activeBytes: 0 };
            this.cameras.set(key, entry);
        }
        return entry;
    }

    private async removeSegment(entry: CameraEntry, segment: SegmentInfo): Promise<number> {
        await fs.rm(segment.path, { force: true });
        entry.segments = entry.segments.filter((item) => item !== segment);
        this.addBytes(-segment.size);
        const dayDir = path.dirname(segment.path);
        const remaining = await fs.readdir(dayDir).catch(() => null);
        if (remaining && remaining.length === 0) await fs.rmdir(dayDir).catch(() => undefined);
        return segment.size;
    }

    private async scan(): Promise<void> {
        await fs.mkdir(this.root, { recursive: true });
        const list = (dir: string) => fs.readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const run of await list(this.root)) {
            if (!run.isDirectory() || !SAFE_SEGMENT.test(run.name)) continue;
            for (const camera of await list(path.join(this.root, run.name))) {
                if (!camera.isDirectory() || !/^[0-9A-F]{12}$/.test(camera.name)) continue;
                const entry = this.entry(run.name, camera.name);
                for (const generation of await list(path.join(this.root, run.name, camera.name))) {
                    if (!generation.isDirectory() || !SAFE_SEGMENT.test(generation.name)) continue;
                    entry.generations.add(generation.name);
                    const generationDir = path.join(this.root, run.name, camera.name, generation.name);
                    for (const day of await list(generationDir)) {
                        if (!day.isDirectory() || !DATE_DIR.test(day.name)) continue;
                        const dayDir = path.join(generationDir, day.name);
                        for (const file of await list(dayDir)) {
                            await this.indexFile(entry, generation.name, day.name, dayDir, file.name);
                        }
                    }
                }
            }
        }
        await this.enforceQuota();
    }

    private async indexFile(entry: CameraEntry, generation: string, day: string, dayDir: string, name: string) {
        const filePath = path.join(dayDir, name);
        const part = PART_FILE.exec(name);
        const complete = SEGMENT_FILE.exec(name);
        const time = part?.[1] || complete?.[1];
        if (!time) return;
        try {
            const inspection = await inspectRecordingFile(filePath);
            let finalPath = filePath;
            if (part) {
                // Interrupted recording: keep the complete fragments, drop the rest.
                if (inspection.fragments === 0) {
                    await fs.rm(filePath, { force: true });
                    return;
                }
                await fs.truncate(filePath, inspection.validLength);
                finalPath = filePath.slice(0, -'.part'.length);
                if (await exists(finalPath)) {
                    await fs.rm(filePath, { force: true });
                    return;
                }
                await fs.rename(filePath, finalPath);
                this.log('Recovered an interrupted recording segment', { path: finalPath });
            } else if (inspection.fragments === 0) {
                await fs.rm(filePath, { force: true });
                return;
            }
            const size = part ? inspection.validLength : inspection.size;
            const startMs = parseSegmentStart(day, time);
            this.addSegment(entry, {
                id: `${day}-${time}`,
                runId: entry.runId,
                macKey: entry.macKey,
                generation,
                path: finalPath,
                startMs,
                endMs: startMs + Math.round(inspection.durationSeconds * 1000),
                size,
            });
            this.addBytes(size);
        } catch (error) {
            this.log('Skipped an unreadable recording file', {
                path: filePath,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
}
