/**
 * smarthome-media-ingest.v1 (docs/architecture/camera-contract.md, section 6.2).
 *
 * WebSocket from the camera to the relay. Text frames carry JSON control
 * messages; binary frames start with a one-byte type:
 *   0x10 init segment (ftyp + moov)
 *   0x11 media fragment (moof + mdat, video and audio in one fragment)
 *   0x12 part of a fetched recording: u32 request_id (big-endian) + bytes
 */
export const INGEST_PROTOCOL = 'smarthome-media-ingest.v1';
export const FRAME_INIT = 0x10;
export const FRAME_FRAGMENT = 0x11;
export const FRAME_FETCH_DATA = 0x12;

export interface RecordingSegmentInfo {
    id: string;
    /** ISO date-time of the first frame. */
    start: string;
    /** ISO date-time right after the last frame. */
    end: string;
    size: number;
    /** Bytes of the init segment at the start of the file. */
    init_length: number;
    /** Identifier of the init segment bytes; equal ids share one EXT-X-MAP. */
    init_id: string;
}

export type CameraMessage =
    | {
        type: 'hello';
        protocol: string;
        session_id: string;
        ingest_token: string;
        mac: string;
        kind: 'live' | 'playback';
        profile_id?: string;
    }
    | { type: 'segment_list'; segments: RecordingSegmentInfo[] }
    | { type: 'fetch_done'; request_id: number }
    | { type: 'fetch_error'; request_id: number; reason: string }
    | { type: 'end'; reason?: string };

export type RelayMessage =
    | { type: 'ready'; session_id: string }
    | { type: 'viewers'; count: number }
    | { type: 'stop'; reason: string }
    | { type: 'fetch'; request_id: number; segment_id: string; offset: number; length: number | null }
    | { type: 'cancel_fetch'; request_id: number }
    | { type: 'error'; code: string; message: string };
