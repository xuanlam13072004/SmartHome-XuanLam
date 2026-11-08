import {
    AUDIO_TRACK_ID,
    buildInitSegment,
    buildMediaFragment,
    VIDEO_TIMESCALE,
    VIDEO_TRACK_ID,
    type AudioTrackConfig,
    type FragmentSample,
    type FragmentTrack,
    type VideoTrackConfig,
} from './fmp4';
import type { MediaStore, SegmentInfo, SegmentWriter } from './media-store';

/** One encoded access unit / audio frame from the virtual camera sensor. */
export interface EncodedMediaChunk {
    kind: 'video' | 'audio';
    keyframe: boolean;
    /** Capture timestamp in microseconds (WebCodecs clock). */
    timestampUs: number;
    durationUs: number;
    data: Uint8Array;
}

export interface RecorderSource {
    video: VideoTrackConfig;
    audio: AudioTrackConfig | null;
}

export interface RecorderOptions {
    store: MediaStore;
    runId: string;
    mac: string;
    /** Current owner boundary; recording pauses while it is unknown. */
    generation: () => string | null;
    now?: () => number;
    fragmentSeconds?: number;
    segmentSeconds?: number;
    onSegmentClosed?: (segment: SegmentInfo) => void;
    /** Every finished fragment, for the live ingest (same bytes as recorded). */
    onFragment?: (init: Uint8Array, fragment: Uint8Array) => void;
    onRecordingChange?: (recording: boolean) => void;
    onError?: (error: Error) => void;
}

interface PendingVideo {
    data: Uint8Array;
    relUs: number;
    keyframe: boolean;
}

interface PendingAudio {
    data: Uint8Array;
    relUs: number;
    durationUs: number;
}

/** Audio capture clocks further apart than this are re-aligned to video. */
const MAX_AV_CLOCK_SKEW_US = 2_000_000;
/** Bounded memory when the sensor stops sending keyframes. */
const MAX_PENDING_FRAGMENT_US = 10_000_000;

/**
 * Virtual camera firmware recorder: packs sensor chunks into CMAF fragments of
 * about `fragmentSeconds` (each starting with an H.264 keyframe) and writes
 * them into 1-minute recording files aligned to UTC minutes. Each file starts
 * with the init segment so it plays on its own.
 */
export class CameraRecorder {
    private readonly now: () => number;
    private readonly fragmentUs: number;
    private readonly segmentMs: number;
    private source: RecorderSource | null = null;
    private init: Uint8Array | null = null;
    private baseUs: number | null = null;
    private wallBaseMs = 0;
    private audioOffsetUs: number | null = null;
    private audioNextDts: number | null = null;
    private lastVideoRelUs = -1;
    private lastFrameUs = 33_333;
    private sequence = 1;
    private pendingVideo: PendingVideo[] = [];
    private pendingAudio: PendingAudio[] = [];
    private writer: SegmentWriter | null = null;
    private chain: Promise<void> = Promise.resolve();
    private recording = false;
    private failed = false;

    constructor(private readonly options: RecorderOptions) {
        this.now = options.now || Date.now;
        this.fragmentUs = Math.round((options.fragmentSeconds ?? 2) * 1_000_000);
        this.segmentMs = Math.round((options.segmentSeconds ?? 60) * 1000);
    }

    get isRecording(): boolean {
        return this.recording;
    }

    get hasFailed(): boolean {
        return this.failed;
    }

    start(source: RecorderSource): void {
        this.source = source;
        this.init = buildInitSegment(source.video, source.audio);
        this.baseUs = null;
        this.audioOffsetUs = null;
        this.audioNextDts = null;
        this.lastVideoRelUs = -1;
        this.sequence = 1;
        this.pendingVideo = [];
        this.pendingAudio = [];
        this.failed = false;
    }

    push(chunks: EncodedMediaChunk[]): void {
        if (!this.source) return;
        for (const chunk of chunks) {
            if (chunk.kind === 'video') this.pushVideo(chunk);
            else if (this.source.audio) this.pushAudio(chunk);
        }
    }

    /** Flushes buffered media and closes the open file. */
    async stop(): Promise<void> {
        if (this.source && this.pendingVideo.length > 0) {
            const last = this.pendingVideo[this.pendingVideo.length - 1];
            this.flush(last.relUs + this.lastFrameUs);
        }
        this.source = null;
        this.init = null;
        this.enqueue(async () => {
            await this.closeWriter();
        });
        await this.chain;
    }

    /** Completes pending writes (tests and shutdown). */
    async idle(): Promise<void> {
        await this.chain;
    }

    /** The minute file being written, up to its last complete fragment. */
    openSegmentSnapshot(): SegmentInfo | null {
        return this.writer?.snapshot() ?? null;
    }

    private pushVideo(chunk: EncodedMediaChunk): void {
        if (this.baseUs === null) {
            if (!chunk.keyframe) return; // a fragment must start with a sync sample
            this.baseUs = chunk.timestampUs;
            this.wallBaseMs = this.now();
        }
        const relUs = chunk.timestampUs - this.baseUs;
        if (relUs <= this.lastVideoRelUs) return; // decode order must be monotonic
        if (this.lastVideoRelUs >= 0) this.lastFrameUs = Math.min(1_000_000, relUs - this.lastVideoRelUs);
        if (chunk.keyframe && this.pendingVideo.length > 0) {
            const span = relUs - this.pendingVideo[0].relUs;
            if (span >= this.fragmentUs * 0.75) this.flush(relUs);
        }
        if (this.pendingVideo.length > 0 && relUs - this.pendingVideo[0].relUs > MAX_PENDING_FRAGMENT_US) {
            // The sensor stopped sending keyframes; drop until the next one.
            this.pendingVideo = [];
            this.pendingAudio = [];
            if (!chunk.keyframe) {
                this.lastVideoRelUs = relUs;
                return;
            }
        }
        if (this.pendingVideo.length === 0 && !chunk.keyframe) {
            this.lastVideoRelUs = relUs;
            return;
        }
        this.lastVideoRelUs = relUs;
        this.pendingVideo.push({ data: chunk.data, relUs, keyframe: chunk.keyframe });
    }

    private pushAudio(chunk: EncodedMediaChunk): void {
        if (this.baseUs === null) return;
        if (this.audioOffsetUs === null) {
            const reference = this.lastVideoRelUs >= 0 ? this.baseUs + this.lastVideoRelUs : this.baseUs;
            const skew = chunk.timestampUs - reference;
            this.audioOffsetUs = Math.abs(skew) > MAX_AV_CLOCK_SKEW_US ? skew : 0;
        }
        const relUs = chunk.timestampUs - this.baseUs - this.audioOffsetUs;
        if (relUs < 0) return;
        this.pendingAudio.push({ data: chunk.data, relUs, durationUs: Math.max(1, chunk.durationUs) });
    }

    private flush(endUs: number): void {
        const video = this.pendingVideo;
        if (video.length === 0 || !this.source || !this.init) return;
        this.pendingVideo = [];
        const audioRate = this.source.audio?.sampleRate || 0;
        const audio = this.pendingAudio.filter((sample) => sample.relUs < endUs);
        this.pendingAudio = this.pendingAudio.filter((sample) => sample.relUs >= endUs);

        const toVideo = (us: number) => Math.round((us * VIDEO_TIMESCALE) / 1_000_000);
        const videoSamples: FragmentSample[] = video.map((sample, index) => {
            const next = index + 1 < video.length ? video[index + 1].relUs : endUs;
            return {
                data: sample.data,
                duration: Math.max(1, toVideo(next) - toVideo(sample.relUs)),
                keyframe: sample.keyframe,
            };
        });
        const tracks: FragmentTrack[] = [{
            trackId: VIDEO_TRACK_ID,
            baseDecodeTime: toVideo(video[0].relUs),
            samples: videoSamples,
        }];
        if (audioRate > 0 && audio.length > 0) {
            this.audioNextDts ??= Math.round((audio[0].relUs * audioRate) / 1_000_000);
            const base = this.audioNextDts;
            const samples = audio.map((sample) => ({
                data: sample.data,
                duration: Math.max(1, Math.round((sample.durationUs * audioRate) / 1_000_000)),
                keyframe: true,
            }));
            this.audioNextDts = base + samples.reduce((sum, sample) => sum + sample.duration, 0);
            tracks.push({ trackId: AUDIO_TRACK_ID, baseDecodeTime: base, samples });
        }

        const fragment = buildMediaFragment(this.sequence++, tracks);
        const startMs = this.wallBaseMs + Math.round(video[0].relUs / 1000);
        const endMs = this.wallBaseMs + Math.round(endUs / 1000);
        const init = this.init;
        this.options.onFragment?.(init, fragment);
        this.enqueue(() => this.writeFragment(init, fragment, startMs, endMs));
    }

    private async writeFragment(init: Uint8Array, fragment: Uint8Array, startMs: number, endMs: number) {
        const generation = this.options.generation();
        if (!generation) {
            await this.closeWriter();
            return;
        }
        const minute = (ms: number) => Math.floor(ms / this.segmentMs);
        if (
            this.writer
            && (minute(startMs) !== minute(this.writer.startMs) || this.writer.generation !== generation)
        ) {
            await this.closeWriter();
        }
        if (!this.writer) {
            this.writer = await this.options.store.openSegment(this.options.runId, this.options.mac, generation, startMs);
            await this.writer.append(init, startMs);
        }
        await this.writer.append(fragment, endMs);
        this.setRecording(true);
    }

    private async closeWriter(): Promise<void> {
        const writer = this.writer;
        this.writer = null;
        if (writer) {
            const segment = await writer.finalize();
            if (segment) this.options.onSegmentClosed?.(segment);
        }
        this.setRecording(false);
    }

    /** Called before a wipe so no file of the old owner stays open. */
    async abortOpenSegment(): Promise<void> {
        await this.chain;
        const writer = this.writer;
        this.writer = null;
        if (writer) await writer.abort();
        this.setRecording(false);
    }

    private setRecording(value: boolean): void {
        if (this.recording === value) return;
        this.recording = value;
        this.options.onRecordingChange?.(value);
    }

    private enqueue(task: () => Promise<void>): void {
        this.chain = this.chain.then(task).catch((error: unknown) => {
            this.failed = true;
            const failure = error instanceof Error ? error : new Error(String(error));
            this.writer?.abort().catch(() => undefined);
            this.writer = null;
            this.setRecording(false);
            this.options.onError?.(failure);
        });
    }
}
