/** Reads the duration of a CMAF fragment (moof + mdat) from its video track. */

const VIDEO_TRACK_ID = 1;
const VIDEO_TIMESCALE = 90_000;

interface Box {
    type: string;
    offset: number;
    size: number;
}

export const listBoxes = (data: Uint8Array, start = 0, end = data.byteLength): Box[] => {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const boxes: Box[] = [];
    let offset = start;
    while (offset + 8 <= end) {
        let size = view.getUint32(offset);
        const type = String.fromCharCode(...data.subarray(offset + 4, offset + 8));
        if (size === 1) {
            if (offset + 16 > end) break;
            size = Number(view.getBigUint64(offset + 8));
        }
        if (size < 8 || offset + size > end) break;
        boxes.push({ type, offset, size });
        offset += size;
    }
    return boxes;
};

export interface FragmentInfo {
    durationSeconds: number;
    /** Video decode time of the first sample in seconds. */
    startSeconds: number;
}

export const readFragmentInfo = (data: Uint8Array): FragmentInfo | null => {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const top = listBoxes(data);
    const moof = top.find((box) => box.type === 'moof');
    if (!moof || !top.some((box) => box.type === 'mdat')) return null;
    for (const traf of listBoxes(data, moof.offset + 8, moof.offset + moof.size)) {
        if (traf.type !== 'traf') continue;
        let trackId = -1;
        let start = 0;
        let duration = 0;
        for (const child of listBoxes(data, traf.offset + 8, traf.offset + traf.size)) {
            const body = child.offset + 8;
            if (child.type === 'tfhd') trackId = view.getUint32(body + 4);
            else if (child.type === 'tfdt') {
                start = data[body] === 1 ? Number(view.getBigUint64(body + 4)) : view.getUint32(body + 4);
            } else if (child.type === 'trun') {
                const flags = view.getUint32(body) & 0xffffff;
                const count = view.getUint32(body + 4);
                let cursor = body + 8 + (flags & 0x1 ? 4 : 0) + (flags & 0x4 ? 4 : 0);
                for (let index = 0; index < count; index += 1) {
                    if (flags & 0x100) {
                        duration += view.getUint32(cursor);
                        cursor += 4;
                    }
                    if (flags & 0x200) cursor += 4;
                    if (flags & 0x400) cursor += 4;
                    if (flags & 0x800) cursor += 4;
                }
            }
        }
        if (trackId === VIDEO_TRACK_ID) {
            return { durationSeconds: duration / VIDEO_TIMESCALE, startSeconds: start / VIDEO_TIMESCALE };
        }
    }
    return null;
};

export const isInitSegment = (data: Uint8Array): boolean => {
    const types = listBoxes(data).map((box) => box.type);
    return types.includes('ftyp') && types.includes('moov');
};
