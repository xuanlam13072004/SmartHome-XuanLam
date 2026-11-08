import type { ProductCatalog } from '../catalog/loader';
import { CameraRecorder, type EncodedMediaChunk } from '../media/camera-recorder';
import type { AudioTrackConfig, VideoTrackConfig } from '../media/fmp4';
import fs from 'node:fs/promises';
import {
    FRAME_FETCH_DATA,
    FRAME_FRAGMENT,
    FRAME_INIT,
    IngestConnection,
    IngestRejected,
    ingestTargetFromContext,
    type IngestTarget,
    type RelayMessage,
} from '../media/ingest-client';
import { readRecordingInit, type MediaStore, type SegmentInfo, type StorageChange } from '../media/media-store';
import { DeviceOperationRejection, type CameraOperationOutcome } from './camera-controller';
import type { TopologyAssignment } from './topology';

/**
 * Virtual security camera firmware (camera contract step 2).
 *
 * The dashboard webcam/microphone is only the image sensor: it delivers H.264 +
 * AAC chunks. This class plays the camera firmware: it records 24/7 into the
 * virtual SD card, enforces the owner boundary (`storage_generation` =
 * topology `device_id`) and answers the recording operations with real data.
 * Live view and playback dial out to the media relay (contract 6.2) with the
 * ingest token the Gateway put into the operation context.
 */

export interface CameraEventDraft {
    instance_id: string;
    event_name: string;
    data: Record<string, unknown>;
}

export interface SecurityCameraHost {
    readonly mac: string;
    readonly runId: string;
    readonly product: ProductCatalog;
    assignment(): TopologyAssignment | undefined;
    /** Backend device id stored when the device was claimed (fallback generation). */
    claimedDeviceId(): Promise<string | null>;
    /** Schedules a reported-state publication; must not be awaited inside an operation. */
    requestReportedSync(): void;
    emitEvent(draft: CameraEventDraft): Promise<void>;
    log(level: 'info' | 'warn', message: string, data?: Record<string, unknown>): void;
}

export interface CameraSourceConfig {
    sessionId: string;
    video: VideoTrackConfig & { framerate: number; codec: string };
    audio: (AudioTrackConfig & { codec: string }) | null;
}

export interface CameraStatus {
    source_active: boolean;
    session_id: string | null;
    video_resolution: string | null;
    audio: boolean;
    recording: boolean;
    generation: string | null;
    storage: {
        used_bytes: number;
        total_bytes: number;
        store_used_bytes: number;
        segments: number;
        oldest_recording_at: string | null;
        newest_recording_at: string | null;
    };
    last_error: string | null;
}

/** No sensor data for this long means the dashboard tab or webcam is gone. */
export const SOURCE_TIMEOUT_MS = 6000;
const MAX_LISTED_RANGES = 120;
/** At most 12 hours of 1-minute files in one playback session. */
const MAX_PLAYBACK_SEGMENTS = 720;
const FETCH_CHUNK_BYTES = 256 * 1024;
const MAX_LIVE_BUFFER_BYTES = 8 * 1024 * 1024;
const MAX_FETCH_BUFFER_BYTES = 4 * 1024 * 1024;

interface PlaybackServer {
    connection: IngestConnection;
    cancelled: Set<number>;
    /** The minute that was still being recorded when the session opened. */
    snapshots: Map<string, SegmentInfo>;
}
const RANGE_GAP_MS = 3000;

/** A snapshot of the recording minute points at its `.part` file, renamed when the minute closes. */
const openRecording = async (filePath: string): Promise<fs.FileHandle> => {
    try {
        return await fs.open(filePath, 'r');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !filePath.endsWith('.part')) throw error;
        return fs.open(filePath.slice(0, -'.part'.length), 'r');
    }
};

let activeSourceCamera: VirtualSecurityCamera | null = null;

export const productHasSecurityCamera = (product: ProductCatalog): boolean =>
    product.capability_instances.some((instance) => instance.capability_id === 'camera_stream')
    && product.capability_instances.some((instance) => instance.capability_id === 'video_recording');

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

const parseTime = (value: unknown, field: string): number => {
    const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
    if (!Number.isFinite(parsed)) throw new DeviceOperationRejection('INVALID_INPUT', `${field} must be an ISO date-time`);
    return parsed;
};

export const mergeRanges = (segments: SegmentInfo[], gapMs = RANGE_GAP_MS) => {
    const ranges: Array<{ startMs: number; endMs: number }> = [];
    for (const segment of [...segments].sort((left, right) => left.startMs - right.startMs)) {
        const last = ranges[ranges.length - 1];
        if (last && segment.startMs - last.endMs <= gapMs) last.endMs = Math.max(last.endMs, segment.endMs);
        else ranges.push({ startMs: segment.startMs, endMs: segment.endMs });
    }
    return ranges;
};

export class VirtualSecurityCamera {
    readonly cameraInstanceId: string;
    readonly recordingInstanceId: string;
    private readonly recorder: CameraRecorder;
    private source: CameraSourceConfig | null = null;
    private lastChunkAt = 0;
    private watchdog: NodeJS.Timeout | null = null;
    private generation: string | null = null;
    private lastError: string | null = null;
    private storageFault = false;
    private disposed = false;
    private boundary: Promise<void> = Promise.resolve();
    private live: IngestConnection | null = null;
    private liveOpening: Promise<IngestConnection> | null = null;
    private liveInitSent: Uint8Array | null = null;
    private liveViewers = 0;
    private readonly playbacks = new Map<string, PlaybackServer>();
    private readonly initCache = new Map<string, { initLength: number; initId: string }>();

    constructor(
        private readonly host: SecurityCameraHost,
        private readonly store: MediaStore,
        now: () => number = Date.now,
    ) {
        const instance = (capability: string) => {
            const found = host.product.capability_instances.find((item) => item.capability_id === capability);
            if (!found) throw new Error(`Security camera product lacks ${capability}`);
            return found.instance_id;
        };
        this.cameraInstanceId = instance('camera_stream');
        this.recordingInstanceId = instance('video_recording');
        this.generation = this.generationFromAssignment(host.assignment());
        this.recorder = new CameraRecorder({
            store,
            runId: host.runId,
            mac: host.mac,
            generation: () => this.generation,
            now,
            onSegmentClosed: () => host.requestReportedSync(),
            onFragment: (init, fragment) => this.forwardLive(init, fragment),
            onRecordingChange: () => host.requestReportedSync(),
            onError: (error) => {
                this.lastError = error.message;
                this.storageFault = true;
                host.log('warn', 'Virtual camera recording failed', { error: error.message });
                void host.emitEvent({
                    instance_id: this.recordingInstanceId,
                    event_name: 'storage_fault',
                    data: { reason: 'write_failed' },
                }).catch(() => undefined);
                host.requestReportedSync();
            },
        });
        store.setListener(host.runId, host.mac, (change) => this.onStorageChange(change));
        // Owner boundary check for recordings left from an earlier owner.
        this.boundary = this.resolveInitialGeneration()
            .then(() => this.enforceOwnerBoundary('owner_changed'))
            .catch((error) => this.boundaryFailed(error));
    }

    get sourceActive(): boolean {
        return this.source !== null;
    }

    /** Reported properties owned by the camera firmware. */
    reported(): Record<string, Record<string, unknown>> {
        const usage = this.store.usage(this.host.runId, this.host.mac, this.generation ?? undefined);
        const recordingState = this.storageFault
            ? 'fault'
            : this.recorder.isRecording ? 'recording' : 'stopped';
        return {
            [this.cameraInstanceId]: {
                camera_state: this.source ? (this.live?.isOpen ? 'streaming' : 'idle') : 'unavailable',
                audio_state: this.source?.audio ? 'ok' : 'unavailable',
                video_resolution: this.source ? `${this.source.video.width}x${this.source.video.height}` : null,
                live_viewers: this.live?.isOpen ? Math.min(5, this.liveViewers) : 0,
            },
            [this.recordingInstanceId]: {
                recording_state: recordingState,
                storage_state: this.storageFault ? 'fault' : this.store.recycling ? 'recycling' : 'ok',
                storage_total_bytes: this.store.quotaBytes,
                storage_used_bytes: usage.usedBytes,
                oldest_recording_at: iso(usage.oldestMs),
                newest_recording_at: iso(usage.newestMs),
            },
        };
    }

    status(): CameraStatus {
        const usage = this.store.usage(this.host.runId, this.host.mac, this.generation ?? undefined);
        return {
            source_active: Boolean(this.source),
            session_id: this.source?.sessionId ?? null,
            video_resolution: this.source ? `${this.source.video.width}x${this.source.video.height}` : null,
            audio: Boolean(this.source?.audio),
            recording: this.recorder.isRecording,
            generation: this.generation,
            storage: {
                used_bytes: usage.usedBytes,
                total_bytes: this.store.quotaBytes,
                store_used_bytes: this.store.usedBytes,
                segments: usage.segments,
                oldest_recording_at: iso(usage.oldestMs),
                newest_recording_at: iso(usage.newestMs),
            },
            last_error: this.lastError,
        };
    }

    segments(): SegmentInfo[] {
        return this.generation ? this.store.listSegments(this.host.runId, this.host.mac, this.generation) : [];
    }

    /** Starts (or replaces) the webcam source. Only one virtual camera may hold the webcam. */
    async startSource(config: CameraSourceConfig, force = false): Promise<void> {
        if (this.disposed) throw new Error('Virtual camera runtime is stopped');
        if (activeSourceCamera && activeSourceCamera !== this) {
            if (!force) {
                throw Object.assign(new Error('Another virtual camera is using the webcam'), {
                    statusCode: 409,
                    code: 'WEBCAM_IN_USE',
                });
            }
            await activeSourceCamera.stopSource(undefined, 'taken_over');
        }
        await this.boundary;
        if (this.source) await this.recorder.stop();
        this.source = config;
        activeSourceCamera = this;
        this.lastChunkAt = Date.now();
        this.storageFault = false;
        this.lastError = null;
        this.recorder.start({ video: config.video, audio: config.audio });
        this.startWatchdog();
        this.host.log('info', 'Virtual camera image source started', {
            resolution: `${config.video.width}x${config.video.height}`,
            audio: Boolean(config.audio),
        });
        this.host.requestReportedSync();
    }

    pushChunks(sessionId: string, chunks: EncodedMediaChunk[]): void {
        if (!this.source || this.source.sessionId !== sessionId) {
            throw Object.assign(new Error('Camera source session is not active'), {
                statusCode: 409,
                code: 'CAMERA_SOURCE_INACTIVE',
            });
        }
        this.lastChunkAt = Date.now();
        this.recorder.push(chunks);
    }

    async stopSource(sessionId?: string, reason = 'stopped'): Promise<void> {
        if (!this.source || (sessionId && this.source.sessionId !== sessionId)) return;
        this.source = null;
        if (activeSourceCamera === this) activeSourceCamera = null;
        this.stopWatchdog();
        this.live?.close('source_stopped');
        await this.recorder.stop();
        this.host.log('info', 'Virtual camera image source stopped', { reason });
        this.host.requestReportedSync();
    }

    async onAssignment(assignment: TopologyAssignment): Promise<void> {
        const next = this.generationFromAssignment(assignment);
        if (!next || next === this.generation) return;
        this.generation = next;
        this.boundary = this.boundary
            .then(() => this.enforceOwnerBoundary('owner_changed'))
            .catch((error) => this.boundaryFailed(error));
        await this.boundary;
    }

    async handleOperation(operation: {
        instance_id: string;
        operation_name: string;
        input: Record<string, unknown>;
        context?: Record<string, unknown>;
    }): Promise<CameraOperationOutcome | null> {
        await this.boundary;
        if (operation.instance_id === this.cameraInstanceId) {
            if (operation.operation_name !== 'create_stream_session') return null;
            if (!this.source) {
                throw new DeviceOperationRejection('CAMERA_UNAVAILABLE', 'The virtual camera has no active image source');
            }
            if (this.live?.isOpen) return { details: { live_viewers: this.liveViewers } };
            const target = ingestTargetFromContext(operation.context, this.host.mac, 'live');
            if (!target) {
                throw new DeviceOperationRejection('MEDIA_INGEST_UNAVAILABLE', 'The session carries no media relay ingest target');
            }
            await this.openLive(target);
            return { details: { live_viewers: this.liveViewers } };
        }
        if (operation.instance_id !== this.recordingInstanceId) return null;
        const input = operation.input || {};
        switch (operation.operation_name) {
            case 'list_recordings':
                return { details: this.listRecordings(input) };
            case 'create_playback_session': {
                const from = parseTime(input.from, 'from');
                const to = input.to === undefined ? Date.now() : parseTime(input.to, 'to');
                const available = this.recordedSegments().some((segment) => segment.endMs > from && segment.startMs < to);
                if (!available) {
                    throw new DeviceOperationRejection('RECORDING_UNAVAILABLE', 'No recording exists in the requested range');
                }
                if (to <= from) throw new DeviceOperationRejection('INVALID_INPUT', 'to must be after from');
                const target = ingestTargetFromContext(operation.context, this.host.mac, 'playback');
                if (!target) {
                    throw new DeviceOperationRejection('MEDIA_INGEST_UNAVAILABLE', 'The session carries no media relay ingest target');
                }
                const segments = await this.openPlayback(target, from, to);
                return { details: { segments } };
            }
            case 'delete_recordings':
                return { details: await this.deleteRecordings(input) };
            default:
                return null;
        }
    }

    async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;
        for (const playback of this.playbacks.values()) playback.connection.close('runtime_stopped');
        this.playbacks.clear();
        await this.stopSource(undefined, 'runtime_stopped');
        await this.recorder.idle();
        this.store.setListener(this.host.runId, this.host.mac, null);
    }

    // ------------------------------------------------------------ live ingest

    private async openLive(target: IngestTarget): Promise<void> {
        if (!this.liveOpening) {
            this.liveOpening = IngestConnection.open(target, (message) => this.onLiveMessage(message))
                .finally(() => {
                    this.liveOpening = null;
                });
        }
        let connection: IngestConnection;
        try {
            connection = await this.liveOpening;
        } catch (error) {
            throw ingestRejection(error);
        }
        if (this.live !== connection) {
            this.live?.close('replaced');
            this.live = connection;
            this.liveInitSent = null;
            this.liveViewers = 0;
            connection.onClose((reason) => {
                if (this.live !== connection) return;
                this.live = null;
                this.liveViewers = 0;
                this.host.log('info', 'Live ingest closed', { reason });
                this.host.requestReportedSync();
            });
            this.host.log('info', 'Live ingest connected to the media relay', {});
            this.host.requestReportedSync();
        }
    }

    private onLiveMessage(message: RelayMessage): void {
        if (message.type === 'viewers') {
            const count = Math.max(0, Math.min(5, Math.floor(Number(message.count) || 0)));
            if (count !== this.liveViewers) {
                this.liveViewers = count;
                this.host.requestReportedSync();
            }
        } else if (message.type === 'stop') {
            this.live?.close('stopped_by_relay');
        }
    }

    /** Sends each recorded fragment to the relay too; drops it when the link is congested. */
    private forwardLive(init: Uint8Array, fragment: Uint8Array): void {
        const live = this.live;
        if (!live?.isOpen) return;
        if (live.bufferedAmount > MAX_LIVE_BUFFER_BYTES) return;
        if (this.liveInitSent !== init) {
            live.sendFrame(FRAME_INIT, init);
            this.liveInitSent = init;
        }
        live.sendFrame(FRAME_FRAGMENT, fragment);
    }

    // ---------------------------------------------------------- playback ingest

    private async openPlayback(target: IngestTarget, from: number, to: number): Promise<number> {
        const segments = this.recordedSegments()
            .filter((segment) => segment.endMs > from && segment.startMs < to)
            .slice(0, MAX_PLAYBACK_SEGMENTS);
        const completedIds = new Set(this.segments().map((segment) => segment.id));
        const snapshots = new Map(segments
            .filter((segment) => !completedIds.has(segment.id))
            .map((segment) => [segment.id, segment]));
        const entries = (await Promise.all(segments.map(async (segment) => {
            try {
                const init = await this.initInfo(segment);
                return {
                    id: segment.id,
                    start: new Date(segment.startMs).toISOString(),
                    end: new Date(segment.endMs).toISOString(),
                    size: segment.size,
                    init_length: init.initLength,
                    init_id: init.initId,
                };
            } catch {
                return null;
            }
        }))).filter((entry) => entry !== null);
        if (entries.length === 0) {
            throw new DeviceOperationRejection('RECORDING_UNAVAILABLE', 'No readable recording exists in the requested range');
        }
        const server: PlaybackServer = { connection: null as unknown as IngestConnection, cancelled: new Set(), snapshots };
        try {
            server.connection = await IngestConnection.open(target, (message) => this.onPlaybackMessage(server, message));
        } catch (error) {
            throw ingestRejection(error);
        }
        this.playbacks.get(target.sessionId)?.connection.close('replaced');
        this.playbacks.set(target.sessionId, server);
        server.connection.onClose(() => {
            if (this.playbacks.get(target.sessionId) === server) this.playbacks.delete(target.sessionId);
        });
        server.connection.sendJson({ type: 'segment_list', segments: entries });
        this.host.log('info', 'Playback ingest connected to the media relay', { segments: entries.length });
        return entries.length;
    }

    private onPlaybackMessage(server: PlaybackServer, message: RelayMessage): void {
        if (message.type === 'fetch') void this.serveFetch(server, message);
        else if (message.type === 'cancel_fetch') server.cancelled.add(Number(message.request_id));
        else if (message.type === 'stop') server.connection.close('stopped_by_relay');
    }

    private async serveFetch(server: PlaybackServer, request: Extract<RelayMessage, { type: 'fetch' }>): Promise<void> {
        const connection = server.connection;
        const requestId = Number(request.request_id);
        // A minute announced while it was being recorded keeps its announced size,
        // so the bytes match the playlist even after the file is completed.
        const segment = server.snapshots.get(String(request.segment_id))
            ?? this.segments().find((item) => item.id === request.segment_id);
        if (!segment) {
            connection.sendJson({ type: 'fetch_error', request_id: requestId, reason: 'recording_unavailable' });
            return;
        }
        const offset = Math.max(0, Math.floor(Number(request.offset) || 0));
        const end = request.length === null || request.length === undefined
            ? segment.size
            : Math.min(segment.size, offset + Math.max(0, Math.floor(Number(request.length))));
        let handle: fs.FileHandle | null = null;
        try {
            handle = await openRecording(segment.path);
            const buffer = Buffer.alloc(FETCH_CHUNK_BYTES);
            let position = offset;
            while (position < end) {
                if (server.cancelled.has(requestId) || !connection.isOpen) return;
                while (connection.bufferedAmount > MAX_FETCH_BUFFER_BYTES) {
                    await new Promise((resolve) => setTimeout(resolve, 20));
                    if (!connection.isOpen || server.cancelled.has(requestId)) return;
                }
                const { bytesRead } = await handle.read(buffer, 0, Math.min(FETCH_CHUNK_BYTES, end - position), position);
                if (bytesRead === 0) break;
                connection.sendFrame(FRAME_FETCH_DATA, buffer.subarray(0, bytesRead), requestId);
                position += bytesRead;
            }
            connection.sendJson({ type: 'fetch_done', request_id: requestId });
        } catch {
            connection.sendJson({ type: 'fetch_error', request_id: requestId, reason: 'recording_unavailable' });
        } finally {
            server.cancelled.delete(requestId);
            await handle?.close().catch(() => undefined);
        }
    }

    private async initInfo(segment: SegmentInfo) {
        const cached = this.initCache.get(segment.path);
        if (cached) return cached;
        const info = await readRecordingInit(segment.path);
        if (this.initCache.size > 2000) this.initCache.clear();
        this.initCache.set(segment.path, info);
        return info;
    }

    /**
     * Completed minute files plus the minute being recorded (up to its last
     * fragment), so a recording can be watched seconds after it was made.
     */
    private recordedSegments(): SegmentInfo[] {
        const completed = this.segments();
        const open = this.recorder.openSegmentSnapshot();
        if (!open || open.generation !== this.generation) return completed;
        if (completed.some((segment) => segment.id === open.id)) return completed;
        return [...completed, open];
    }

    private listRecordings(input: Record<string, unknown>) {
        const from = parseTime(input.from, 'from');
        const to = parseTime(input.to, 'to');
        if (to <= from) throw new DeviceOperationRejection('INVALID_INPUT', 'to must be after from');
        const after = input.cursor === undefined ? from : Math.max(from, parseTime(input.cursor, 'cursor'));
        const ranges = mergeRanges(this.recordedSegments())
            .filter((range) => range.endMs > after && range.startMs < to)
            .map((range) => ({ startMs: Math.max(range.startMs, after), endMs: Math.min(range.endMs, to) }))
            .filter((range) => range.endMs > range.startMs);
        const page = ranges.slice(0, MAX_LISTED_RANGES);
        return {
            ranges: page.map((range) => ({ start: iso(range.startMs), end: iso(range.endMs) })),
            next_cursor: ranges.length > page.length ? iso(page[page.length - 1].endMs) : null,
        };
    }

    private async deleteRecordings(input: Record<string, unknown>) {
        if (!this.generation) return { deleted_segments: 0, freed_bytes: 0 };
        let predicate: (segment: SegmentInfo) => boolean;
        if (input.all === true) {
            predicate = () => true;
        } else {
            if (input.from === undefined && input.to === undefined) {
                throw new DeviceOperationRejection('INVALID_INPUT', 'Provide from/to or all=true');
            }
            const from = input.from === undefined ? Number.NEGATIVE_INFINITY : parseTime(input.from, 'from');
            const to = input.to === undefined ? Number.POSITIVE_INFINITY : parseTime(input.to, 'to');
            if (to <= from) throw new DeviceOperationRejection('INVALID_INPUT', 'to must be after from');
            predicate = (segment) => segment.endMs > from && segment.startMs < to;
        }
        // The segment being written is not in the completed index, so it is never deleted.
        const change = await this.store.deleteSegments(this.host.runId, this.host.mac, this.generation, predicate);
        const data = { deleted_segments: change.deletedSegments, freed_bytes: change.freedBytes };
        if (change.deletedSegments > 0) {
            await this.host.emitEvent({
                instance_id: this.recordingInstanceId,
                event_name: 'recordings_deleted',
                data,
            }).catch(() => undefined);
        }
        this.host.requestReportedSync();
        return data;
    }

    private onStorageChange(change: StorageChange): void {
        if (change.reason === 'recycled') {
            void this.host.emitEvent({
                instance_id: this.recordingInstanceId,
                event_name: 'storage_recycled',
                data: { deleted_segments: change.deletedSegments, freed_bytes: change.freedBytes },
            }).catch(() => undefined);
        }
        this.host.requestReportedSync();
    }

    private async resolveInitialGeneration(): Promise<void> {
        if (this.generation) return;
        const claimed = (await this.host.claimedDeviceId())?.trim();
        if (!this.generation && claimed && /^[A-Za-z0-9_-]{1,96}$/.test(claimed)) {
            this.generation = claimed;
            this.host.requestReportedSync();
        }
    }

    private generationFromAssignment(assignment?: TopologyAssignment): string | null {
        const member = assignment?.members.find((item) => item.mac.toUpperCase() === this.host.mac.toUpperCase());
        const id = member?.device_id?.trim();
        return id && /^[A-Za-z0-9_-]{1,96}$/.test(id) ? id : null;
    }

    /** Wipes recordings that belong to any other owner generation. */
    private async enforceOwnerBoundary(reason: 'owner_changed'): Promise<void> {
        const generation = this.generation;
        if (!generation) return;
        await this.store.init();
        const stale = this.store.generations(this.host.runId, this.host.mac)
            .filter((item) => item !== generation);
        if (stale.length === 0) return;
        await this.recorder.abortOpenSegment();
        const change = await this.store.wipeCamera(this.host.runId, this.host.mac, generation);
        this.host.log('info', 'Wiped recordings of a previous owner', {
            generations: stale.length,
            deleted_segments: change.deletedSegments,
        });
        await this.host.emitEvent({
            instance_id: this.recordingInstanceId,
            event_name: 'recordings_wiped',
            data: { reason, deleted_segments: change.deletedSegments },
        }).catch(() => undefined);
        this.host.requestReportedSync();
    }

    private boundaryFailed(error: unknown): void {
        this.storageFault = true;
        this.lastError = error instanceof Error ? error.message : String(error);
        this.host.log('warn', 'Virtual camera could not enforce the owner boundary', { error: this.lastError });
        this.host.requestReportedSync();
    }

    private startWatchdog(): void {
        this.stopWatchdog();
        this.watchdog = setInterval(() => {
            if (this.source && Date.now() - this.lastChunkAt > SOURCE_TIMEOUT_MS) {
                void this.stopSource(undefined, 'source_lost');
            }
        }, 2000);
        this.watchdog.unref?.();
    }

    private stopWatchdog(): void {
        if (this.watchdog) clearInterval(this.watchdog);
        this.watchdog = null;
    }
}

const ingestRejection = (error: unknown): DeviceOperationRejection => {
    if (error instanceof IngestRejected) return new DeviceOperationRejection(error.code === 'INGEST_FORBIDDEN' ? 'MEDIA_INGEST_FORBIDDEN' : 'MEDIA_INGEST_FAILED', error.message);
    return new DeviceOperationRejection('MEDIA_INGEST_FAILED', error instanceof Error ? error.message : 'Media relay connection failed');
};
