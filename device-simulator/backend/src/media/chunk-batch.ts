import type { EncodedMediaChunk } from './camera-recorder';

/**
 * Internal Simulator transport from the dashboard (the camera "sensor") to the
 * virtual camera firmware. Not part of the SmartHome contract.
 *
 * Batch = repeated records:
 *   u8 kind (1 = video, 2 = audio) | u8 flags (bit 0 = keyframe) | u16 reserved
 *   f64 timestamp_us | u32 duration_us | u32 byte_length | payload
 * All integers big-endian.
 */
export const CHUNK_RECORD_HEADER_BYTES = 20;
export const MAX_CHUNK_BYTES = 4 * 1024 * 1024;

export const parseChunkBatch = (body: Uint8Array): EncodedMediaChunk[] => {
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const chunks: EncodedMediaChunk[] = [];
    let offset = 0;
    while (offset < body.byteLength) {
        if (offset + CHUNK_RECORD_HEADER_BYTES > body.byteLength) throw new Error('Truncated media chunk header');
        const kind = view.getUint8(offset);
        const flags = view.getUint8(offset + 1);
        const timestampUs = view.getFloat64(offset + 4);
        const durationUs = view.getUint32(offset + 12);
        const length = view.getUint32(offset + 16);
        offset += CHUNK_RECORD_HEADER_BYTES;
        if (kind !== 1 && kind !== 2) throw new Error('Unknown media chunk kind');
        if (!Number.isFinite(timestampUs)) throw new Error('Media chunk timestamp is invalid');
        if (length === 0 || length > MAX_CHUNK_BYTES || offset + length > body.byteLength) {
            throw new Error('Media chunk length is invalid');
        }
        chunks.push({
            kind: kind === 1 ? 'video' : 'audio',
            keyframe: (flags & 1) === 1,
            timestampUs,
            durationUs,
            data: body.slice(offset, offset + length),
        });
        offset += length;
    }
    return chunks;
};

export const encodeChunkBatch = (chunks: EncodedMediaChunk[]): Uint8Array => {
    const size = chunks.reduce((sum, chunk) => sum + CHUNK_RECORD_HEADER_BYTES + chunk.data.byteLength, 0);
    const out = new Uint8Array(size);
    const view = new DataView(out.buffer);
    let offset = 0;
    for (const chunk of chunks) {
        view.setUint8(offset, chunk.kind === 'video' ? 1 : 2);
        view.setUint8(offset + 1, chunk.keyframe ? 1 : 0);
        view.setFloat64(offset + 4, chunk.timestampUs);
        view.setUint32(offset + 12, chunk.durationUs);
        view.setUint32(offset + 16, chunk.data.byteLength);
        out.set(chunk.data, offset + CHUNK_RECORD_HEADER_BYTES);
        offset += CHUNK_RECORD_HEADER_BYTES + chunk.data.byteLength;
    }
    return out;
};
