/**
 * Minimal CMAF/fragmented-MP4 writer and reader for the virtual security
 * camera (docs/architecture/camera-contract.md, media profile h264_aac_cmaf_v1).
 *
 * Writer: one init segment (ftyp + moov) and media fragments (moof + mdat)
 * carrying H.264 (AVCC samples, avcC configuration) and optional AAC-LC
 * (raw frames, AudioSpecificConfig). Track 1 is always video, track 2 audio.
 * Reader: just enough to recover interrupted recordings and measure their
 * duration, for files this writer produced.
 */

export const VIDEO_TRACK_ID = 1;
export const AUDIO_TRACK_ID = 2;
export const VIDEO_TIMESCALE = 90_000;

export interface VideoTrackConfig {
    width: number;
    height: number;
    /** avcC (AVCDecoderConfigurationRecord), WebCodecs `decoderConfig.description`. */
    avcC: Uint8Array;
}

export interface AudioTrackConfig {
    sampleRate: number;
    channels: number;
    /** AudioSpecificConfig, WebCodecs `decoderConfig.description`. */
    asc: Uint8Array;
}

export interface FragmentSample {
    data: Uint8Array;
    /** Duration in the track timescale. */
    duration: number;
    keyframe: boolean;
}

export interface FragmentTrack {
    trackId: number;
    /** Decode time of the first sample, in the track timescale. */
    baseDecodeTime: number;
    samples: FragmentSample[];
}

const encoder = new TextEncoder();

const u8 = (value: number) => Uint8Array.of(value & 0xff);
const u16 = (value: number) => Uint8Array.of((value >>> 8) & 0xff, value & 0xff);
const u24 = (value: number) => Uint8Array.of((value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
const u32 = (value: number) => {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value >>> 0);
    return out;
};
const u64 = (value: number) => {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, BigInt(Math.max(0, Math.floor(value))));
    return out;
};
const zeros = (length: number) => new Uint8Array(length);
const ascii = (value: string) => encoder.encode(value);

const concat = (parts: Uint8Array[]): Uint8Array => {
    const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const out = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.byteLength;
    }
    return out;
};

const box = (type: string, ...payload: Uint8Array[]): Uint8Array => {
    const body = concat(payload);
    return concat([u32(body.byteLength + 8), ascii(type), body]);
};

const fullBox = (type: string, version: number, flags: number, ...payload: Uint8Array[]) =>
    box(type, u8(version), u24(flags), ...payload);

const IDENTITY_MATRIX = concat([
    u32(0x00010000), u32(0), u32(0),
    u32(0), u32(0x00010000), u32(0),
    u32(0), u32(0), u32(0x40000000),
]);

/** MPEG-4 descriptor with a fixed four-byte length field. */
const descriptor = (tag: number, ...payload: Uint8Array[]) => {
    const body = concat(payload);
    const size = body.byteLength;
    return concat([
        u8(tag),
        Uint8Array.of(0x80 | ((size >> 21) & 0x7f), 0x80 | ((size >> 14) & 0x7f), 0x80 | ((size >> 7) & 0x7f), size & 0x7f),
        body,
    ]);
};

const mvhd = (nextTrackId: number) => fullBox('mvhd', 0, 0,
    u32(0), u32(0), // creation / modification time
    u32(1000), u32(0), // timescale, duration (fragmented: unknown)
    u32(0x00010000), u16(0x0100), zeros(10), // rate, volume, reserved
    IDENTITY_MATRIX, zeros(24), u32(nextTrackId));

const tkhd = (trackId: number, width: number, height: number, audio: boolean) => fullBox('tkhd', 0, 0x000003,
    u32(0), u32(0), u32(trackId), u32(0), u32(0), // times, track id, reserved, duration
    zeros(8), u16(0), u16(audio ? 1 : 0), u16(audio ? 0x0100 : 0), u16(0),
    IDENTITY_MATRIX, u32(width << 16), u32(height << 16));

const mdhd = (timescale: number) => fullBox('mdhd', 0, 0,
    u32(0), u32(0), u32(timescale), u32(0), u16(0x55c4) /* und */, u16(0));

const hdlr = (handler: 'vide' | 'soun', name: string) => fullBox('hdlr', 0, 0,
    u32(0), ascii(handler), zeros(12), ascii(`${name}\0`));

const dinf = () => box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 0x000001)));

const emptySampleTables = () => [
    fullBox('stts', 0, 0, u32(0)),
    fullBox('stsc', 0, 0, u32(0)),
    fullBox('stsz', 0, 0, u32(0), u32(0)),
    fullBox('stco', 0, 0, u32(0)),
];

const avc1 = (config: VideoTrackConfig) => box('avc1',
    zeros(6), u16(1), // reserved, data_reference_index
    zeros(16), u16(config.width), u16(config.height),
    u32(0x00480000), u32(0x00480000), u32(0), u16(1), // resolution, reserved, frame count
    zeros(32), u16(0x0018), u16(0xffff), // compressor name, depth, pre_defined
    box('avcC', config.avcC));

const mp4a = (config: AudioTrackConfig) => box('mp4a',
    zeros(6), u16(1), zeros(8),
    u16(config.channels), u16(16), u16(0), u16(0), u32(config.sampleRate << 16),
    fullBox('esds', 0, 0, descriptor(0x03,
        u16(AUDIO_TRACK_ID), u8(0),
        descriptor(0x04,
            u8(0x40), u8(0x15), u24(0), u32(0), u32(0), // MPEG-4 audio, audio stream
            descriptor(0x05, config.asc)),
        descriptor(0x06, u8(0x02)))));

const videoTrak = (config: VideoTrackConfig) => box('trak',
    tkhd(VIDEO_TRACK_ID, config.width, config.height, false),
    box('mdia', mdhd(VIDEO_TIMESCALE), hdlr('vide', 'SmartHome Video'),
        box('minf', fullBox('vmhd', 0, 1, zeros(8)), dinf(),
            box('stbl', fullBox('stsd', 0, 0, u32(1), avc1(config)), ...emptySampleTables()))));

const audioTrak = (config: AudioTrackConfig) => box('trak',
    tkhd(AUDIO_TRACK_ID, 0, 0, true),
    box('mdia', mdhd(config.sampleRate), hdlr('soun', 'SmartHome Audio'),
        box('minf', fullBox('smhd', 0, 0, zeros(4)), dinf(),
            box('stbl', fullBox('stsd', 0, 0, u32(1), mp4a(config)), ...emptySampleTables()))));

const trex = (trackId: number) => fullBox('trex', 0, 0, u32(trackId), u32(1), u32(0), u32(0), u32(0));

export const buildInitSegment = (video: VideoTrackConfig, audio?: AudioTrackConfig | null): Uint8Array => {
    if (!video.avcC?.byteLength) throw new Error('H.264 avcC configuration is required');
    if (audio && !audio.asc?.byteLength) throw new Error('AAC AudioSpecificConfig is required');
    const traks = [videoTrak(video), ...(audio ? [audioTrak(audio)] : [])];
    const trexes = [trex(VIDEO_TRACK_ID), ...(audio ? [trex(AUDIO_TRACK_ID)] : [])];
    return concat([
        box('ftyp', ascii('iso6'), u32(0), ascii('iso6'), ascii('cmfc'), ascii('isom'), ascii('mp41')),
        box('moov', mvhd(audio ? 3 : 2), ...traks, box('mvex', ...trexes)),
    ]);
};

const KEY_SAMPLE_FLAGS = 0x02000000; // depends on no other sample
const DELTA_SAMPLE_FLAGS = 0x01010000; // depends on others, not a sync sample
const TRUN_FLAGS = 0x000001 | 0x000100 | 0x000200 | 0x000400; // offset, duration, size, flags

export const buildMediaFragment = (sequenceNumber: number, tracks: FragmentTrack[]): Uint8Array => {
    const present = tracks.filter((track) => track.samples.length > 0);
    if (present.length === 0) throw new Error('A media fragment needs at least one sample');
    const build = (dataOffsets: number[]) => box('moof',
        fullBox('mfhd', 0, 0, u32(sequenceNumber)),
        ...present.map((track, index) => box('traf',
            fullBox('tfhd', 0, 0x020000, u32(track.trackId)), // default-base-is-moof
            fullBox('tfdt', 1, 0, u64(track.baseDecodeTime)),
            fullBox('trun', 0, TRUN_FLAGS,
                u32(track.samples.length), u32(dataOffsets[index]),
                ...track.samples.map((sample) => concat([
                    u32(sample.duration),
                    u32(sample.data.byteLength),
                    u32(sample.keyframe ? KEY_SAMPLE_FLAGS : DELTA_SAMPLE_FLAGS),
                ]))))));
    const moofSize = build(present.map(() => 0)).byteLength;
    const offsets: number[] = [];
    let offset = moofSize + 8; // moof + mdat header
    for (const track of present) {
        offsets.push(offset);
        offset += track.samples.reduce((sum, sample) => sum + sample.data.byteLength, 0);
    }
    return concat([
        build(offsets),
        box('mdat', ...present.flatMap((track) => track.samples.map((sample) => sample.data))),
    ]);
};

export interface TopLevelBox {
    type: string;
    offset: number;
    size: number;
}

/** Walks complete top-level boxes; stops at the first truncated or invalid box. */
export const listTopLevelBoxes = (data: Uint8Array): { boxes: TopLevelBox[]; complete: number } => {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const boxes: TopLevelBox[] = [];
    let offset = 0;
    while (offset + 8 <= data.byteLength) {
        let size = view.getUint32(offset);
        const type = String.fromCharCode(...data.subarray(offset + 4, offset + 8));
        if (size === 1) {
            if (offset + 16 > data.byteLength) break;
            size = Number(view.getBigUint64(offset + 8));
        }
        if (size < 8 || offset + size > data.byteLength || !/^[\x20-\x7e]{4}$/.test(type)) break;
        boxes.push({ type, offset, size });
        offset += size;
    }
    return { boxes, complete: offset };
};

const childBoxes = (data: Uint8Array, start: number, end: number) => {
    const { boxes } = listTopLevelBoxes(data.subarray(start, end));
    return boxes.map((child) => ({ ...child, offset: child.offset + start }));
};

export interface FragmentTiming {
    /** Video decode time of the first sample, VIDEO_TIMESCALE units. */
    start: number;
    /** Video decode time right after the last sample. */
    end: number;
}

/** Video timing of one moof written by buildMediaFragment. */
export const readVideoFragmentTiming = (data: Uint8Array, moof: TopLevelBox): FragmentTiming | null => {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (const traf of childBoxes(data, moof.offset + 8, moof.offset + moof.size)) {
        if (traf.type !== 'traf') continue;
        let trackId = -1;
        let start: number | null = null;
        let duration = 0;
        for (const child of childBoxes(data, traf.offset + 8, traf.offset + traf.size)) {
            const body = child.offset + 8;
            if (child.type === 'tfhd') trackId = view.getUint32(body + 4);
            if (child.type === 'tfdt') {
                start = data[body] === 1
                    ? Number(view.getBigUint64(body + 4))
                    : view.getUint32(body + 4);
            }
            if (child.type === 'trun') {
                const flags = view.getUint32(body) & 0xffffff;
                const count = view.getUint32(body + 4);
                let cursor = body + 8;
                if (flags & 0x000001) cursor += 4;
                if (flags & 0x000004) cursor += 4;
                for (let index = 0; index < count; index += 1) {
                    if (flags & 0x000100) {
                        duration += view.getUint32(cursor);
                        cursor += 4;
                    }
                    if (flags & 0x000200) cursor += 4;
                    if (flags & 0x000400) cursor += 4;
                    if (flags & 0x000800) cursor += 4;
                }
            }
        }
        if (trackId === VIDEO_TRACK_ID && start !== null) return { start, end: start + duration };
    }
    return null;
};

export interface RecordingInspection {
    /** Bytes forming init + complete moof/mdat pairs. */
    validLength: number;
    fragments: number;
    durationSeconds: number;
}

/** Inspects a recording file produced by the recorder (init segment + fragments). */
export const inspectRecording = (data: Uint8Array): RecordingInspection => {
    const { boxes } = listTopLevelBoxes(data);
    let validLength = 0;
    let fragments = 0;
    let first: number | null = null;
    let last: number | null = null;
    let sawMoov = false;
    for (let index = 0; index < boxes.length; index += 1) {
        const current = boxes[index];
        if (current.type === 'ftyp') continue;
        if (current.type === 'moov') {
            sawMoov = true;
            validLength = current.offset + current.size;
            continue;
        }
        if (current.type === 'moof' && sawMoov) {
            const mdat = boxes[index + 1];
            if (!mdat || mdat.type !== 'mdat') break;
            const timing = readVideoFragmentTiming(data, current);
            if (timing) {
                first ??= timing.start;
                last = timing.end;
            }
            fragments += 1;
            validLength = mdat.offset + mdat.size;
            index += 1;
        }
    }
    return {
        validLength: fragments > 0 ? validLength : 0,
        fragments,
        durationSeconds: first !== null && last !== null ? Math.max(0, last - first) / VIDEO_TIMESCALE : 0,
    };
};

/** AudioSpecificConfig for AAC-LC when an encoder does not provide one. */
export const aacLcAudioSpecificConfig = (sampleRate: number, channels: number): Uint8Array => {
    const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    const index = rates.indexOf(sampleRate);
    if (index < 0) throw new Error(`Unsupported AAC sample rate ${sampleRate}`);
    const value = (2 << 11) | (index << 7) | ((channels & 0x0f) << 3);
    return Uint8Array.of(value >> 8, value & 0xff);
};
