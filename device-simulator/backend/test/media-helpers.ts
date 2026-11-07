import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { EncodedMediaChunk } from '../src/media/camera-recorder';

export const tempDir = async (label: string) => fs.mkdtemp(path.join(os.tmpdir(), `sim-${label}-`));

/** A minimal avcC record (version 1); the muxer does not parse SPS/PPS. */
export const fakeAvcC = Uint8Array.of(1, 0x42, 0xe0, 0x1f, 0xff, 0xe1, 0, 4, 0x67, 0x42, 0xe0, 0x1f, 1, 0, 2, 0x68, 0xce);

/** Synthetic 30 fps video with a keyframe every 2 s, plus 48 kHz AAC frames. */
export const syntheticStream = (seconds: number, startUs = 5_000_000, frameBytes = 2000): EncodedMediaChunk[] => {
    const chunks: EncodedMediaChunk[] = [];
    const frameUs = 1_000_000 / 30;
    const audioUs = (1024 / 48000) * 1_000_000;
    let audioTs = startUs;
    for (let frame = 0; frame < seconds * 30; frame += 1) {
        const ts = startUs + Math.round(frame * frameUs);
        chunks.push({ kind: 'video', keyframe: frame % 60 === 0, timestampUs: ts, durationUs: Math.round(frameUs), data: new Uint8Array(frameBytes).fill(frame % 251) });
        while (audioTs <= ts) {
            chunks.push({ kind: 'audio', keyframe: true, timestampUs: Math.round(audioTs), durationUs: Math.round(audioUs), data: new Uint8Array(200).fill(7) });
            audioTs += audioUs;
        }
    }
    return chunks;
};

export const listFiles = async (root: string): Promise<string[]> => {
    const out: string[] = [];
    const walk = async (dir: string) => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) await walk(full);
            else out.push(path.relative(root, full).split(path.sep).join('/'));
        }
    };
    await walk(root);
    return out.sort();
};
