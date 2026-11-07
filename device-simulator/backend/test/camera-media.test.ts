import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { CameraRecorder } from '../src/media/camera-recorder';
import { encodeChunkBatch, parseChunkBatch } from '../src/media/chunk-batch';
import {
    aacLcAudioSpecificConfig,
    buildInitSegment,
    buildMediaFragment,
    inspectRecording,
    listTopLevelBoxes,
} from '../src/media/fmp4';
import { inspectRecordingFile, MediaStore } from '../src/media/media-store';
import { fakeAvcC, listFiles, syntheticStream, tempDir } from './media-helpers';

const RUN = 'run-test';
const MAC = 'AA:BB:CC:DD:EE:01';
const MAC2 = 'AA:BB:CC:DD:EE:02';
const GEN = 'gen-1';
const source = {
    video: { width: 1280, height: 720, avcC: fakeAvcC },
    audio: { sampleRate: 48000, channels: 1, asc: aacLcAudioSpecificConfig(48000, 1) },
};

test('init segment and fragments form a CMAF file whose duration can be measured', () => {
    const init = buildInitSegment(source.video, source.audio);
    assert.deepEqual(listTopLevelBoxes(init).boxes.map((box) => box.type), ['ftyp', 'moov']);
    const fragment = (seq: number, start: number) => buildMediaFragment(seq, [
        { trackId: 1, baseDecodeTime: start, samples: Array.from({ length: 60 }, (_, index) => ({ data: new Uint8Array(10), duration: 3000, keyframe: index === 0 })) },
        { trackId: 2, baseDecodeTime: start / 90000 * 48000, samples: [{ data: new Uint8Array(5), duration: 1024, keyframe: true }] },
    ]);
    const file = new Uint8Array([...init, ...fragment(1, 0), ...fragment(2, 180000)]);
    const inspection = inspectRecording(file);
    assert.equal(inspection.fragments, 2);
    assert.equal(inspection.durationSeconds, 4);
    assert.equal(inspection.validLength, file.byteLength);
    const truncated = inspectRecording(file.subarray(0, file.byteLength - 3));
    assert.equal(truncated.fragments, 1);
    assert.equal(truncated.durationSeconds, 2);
});

test('AAC AudioSpecificConfig matches the AAC-LC 48 kHz mono profile', () => {
    assert.deepEqual([...aacLcAudioSpecificConfig(48000, 1)], [0x11, 0x88]);
    assert.throws(() => aacLcAudioSpecificConfig(12345, 1));
});

test('sensor chunk batches round-trip and reject malformed input', () => {
    const chunks = syntheticStream(1).slice(0, 5);
    const parsed = parseChunkBatch(encodeChunkBatch(chunks));
    assert.equal(parsed.length, 5);
    assert.deepEqual(parsed.map((chunk) => chunk.kind), chunks.map((chunk) => chunk.kind));
    assert.equal(parsed[0].keyframe, true);
    assert.equal(parsed[0].timestampUs, chunks[0].timestampUs);
    assert.throws(() => parseChunkBatch(Uint8Array.of(9, 0, 0, 0)), /Truncated/);
    const bad = encodeChunkBatch(chunks.slice(0, 1));
    bad[0] = 7;
    assert.throws(() => parseChunkBatch(bad), /Unknown/);
});

test('recorder writes 1-minute files aligned to UTC minutes, each starting with the init segment', async () => {
    const root = await tempDir('rec');
    const store = new MediaStore(root, 1024 * 1024 * 1024);
    const closed: string[] = [];
    let wall = Date.UTC(2026, 10, 5, 8, 0, 50); // 08:00:50 UTC
    const recorder = new CameraRecorder({ store, runId: RUN, mac: MAC, generation: () => GEN, now: () => wall, onSegmentClosed: (segment) => closed.push(segment.id) });
    recorder.start(source);
    recorder.push(syntheticStream(20));
    await recorder.stop();
    const files = await listFiles(root);
    assert.deepEqual(files, [
        `${RUN}/AABBCCDDEE01/${GEN}/20261105/080050.mp4`,
        `${RUN}/AABBCCDDEE01/${GEN}/20261105/080100.mp4`,
    ]);
    assert.deepEqual(closed, ['20261105-080050', '20261105-080100']);
    const first = await inspectRecordingFile(path.join(root, files[0]));
    const second = await inspectRecordingFile(path.join(root, files[1]));
    assert.equal(first.durationSeconds, 10);
    assert.ok(Math.abs(second.durationSeconds - 10) < 0.1);
    const secondBytes = new Uint8Array(await fs.readFile(path.join(root, files[1])));
    assert.deepEqual(listTopLevelBoxes(secondBytes).boxes.slice(0, 3).map((box) => box.type), ['ftyp', 'moov', 'moof']);
    const segments = store.listSegments(RUN, MAC, GEN);
    assert.equal(segments.length, 2);
    assert.equal(segments[0].endMs, Date.UTC(2026, 10, 5, 8, 1, 0));
    assert.equal(store.usage(RUN, MAC, GEN).usedBytes, segments[0].size + segments[1].size);
    wall += 0;
});

test('recorder does not record while the owner generation is unknown', async () => {
    const root = await tempDir('nogen');
    const store = new MediaStore(root, 1024 * 1024 * 1024);
    const recorder = new CameraRecorder({ store, runId: RUN, mac: MAC, generation: () => null });
    recorder.start(source);
    recorder.push(syntheticStream(5));
    await recorder.stop();
    assert.deepEqual(await listFiles(root), []);
});

test('quota recycles the oldest completed segment of any camera, never an open one', async () => {
    const root = await tempDir('quota');
    const changes: number[] = [];
    const store = new MediaStore(root, 1_200_000);
    store.setListener(RUN, MAC, (change) => changes.push(change.deletedSegments));
    const write = async (mac: string, startMs: number, bytes: number) => {
        const writer = await store.openSegment(RUN, mac, GEN, startMs);
        await writer.append(new Uint8Array(bytes), startMs + 60_000);
        return writer.finalize();
    };
    await write(MAC, Date.UTC(2026, 0, 1, 0, 0), 500_000);
    await write(MAC2, Date.UTC(2026, 0, 1, 0, 1), 500_000);
    const open = await store.openSegment(RUN, MAC2, GEN, Date.UTC(2026, 0, 1, 0, 2));
    await open.append(new Uint8Array(500_000), Date.UTC(2026, 0, 1, 0, 3));
    assert.ok(store.usedBytes <= 1_200_000);
    assert.deepEqual(store.listSegments(RUN, MAC), []);
    assert.equal(store.listSegments(RUN, MAC2).length, 1);
    assert.deepEqual(changes, [1]);
    await open.finalize();
    assert.equal(store.listSegments(RUN, MAC2).length, 2);
});

test('startup scan recovers interrupted files and rebuilds the index from disk', async () => {
    const root = await tempDir('scan');
    const store = new MediaStore(root, 1024 * 1024 * 1024);
    const recorder = new CameraRecorder({ store, runId: RUN, mac: MAC, generation: () => GEN, now: () => Date.UTC(2026, 10, 5, 9, 0, 0) });
    recorder.start(source);
    recorder.push(syntheticStream(9));
    await recorder.stop();
    const [file] = await listFiles(root);
    const full = path.join(root, file);
    const bytes = await fs.readFile(full);
    const interrupted = full.replace('090000.mp4', '090100.mp4.part');
    await fs.writeFile(interrupted, bytes.subarray(0, bytes.length - 100));
    await fs.writeFile(full.replace('090000.mp4', '090200.mp4.part'), bytes.subarray(0, 50));

    const rescanned = new MediaStore(root, 1024 * 1024 * 1024);
    await rescanned.init();
    const segments = rescanned.listSegments(RUN, MAC, GEN);
    assert.deepEqual(segments.map((segment) => segment.id), ['20261105-090000', '20261105-090100']);
    assert.ok(segments[1].endMs > segments[1].startMs);
    assert.deepEqual((await listFiles(root)).map((item) => path.basename(item)), ['090000.mp4', '090100.mp4']);
    assert.equal(rescanned.usedBytes, segments[0].size + segments[1].size);
});

test('wipe keeps only the current owner generation, and a full wipe removes the camera folder', async () => {
    const root = await tempDir('wipe');
    const store = new MediaStore(root, 1024 * 1024 * 1024);
    for (const generation of ['old-owner', 'new-owner']) {
        const writer = await store.openSegment(RUN, MAC, generation, Date.UTC(2026, 0, 1));
        await writer.append(new Uint8Array(100), Date.UTC(2026, 0, 1, 0, 1));
        await writer.finalize();
    }
    const partial = await store.wipeCamera(RUN, MAC, 'new-owner');
    assert.equal(partial.deletedSegments, 1);
    assert.deepEqual(store.generations(RUN, MAC), ['new-owner']);
    assert.equal(store.usedBytes, 100);
    await store.wipeCamera(RUN, MAC);
    assert.deepEqual(await listFiles(root), []);
    assert.equal(store.usedBytes, 0);
    assert.deepEqual(await fs.readdir(root), []);
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test('recorded files decode with ffmpeg (real H.264 + AAC)', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
    const dir = await tempDir('ffmpeg');
    const h264 = path.join(dir, 'v.h264');
    const aac = path.join(dir, 'a.aac');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30', '-t', '5', '-c:v', 'libx264', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0', '-x264-params', 'aud=1', '-f', 'h264', h264]);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '5', '-ac', '1', '-c:a', 'aac', '-b:a', '96k', '-f', 'adts', aac]);
    const stream = await fs.readFile(h264);
    const starts: number[] = [];
    for (let index = 0; index + 3 < stream.length; index += 1) {
        if (stream[index] === 0 && stream[index + 1] === 0 && stream[index + 2] === 1) {
            starts.push(index + 3);
            index += 2;
        }
    }
    const nals = starts.map((start, index) => {
        let end = index + 1 < starts.length ? starts[index + 1] - 3 : stream.length;
        while (end > start && stream[end - 1] === 0) end -= 1;
        return stream.subarray(start, end);
    });
    let sps: Buffer | undefined;
    let pps: Buffer | undefined;
    const units: Array<{ nals: Buffer[]; key: boolean }> = [];
    for (const nal of nals) {
        const type = nal[0] & 31;
        if (type === 9) units.push({ nals: [], key: false });
        else if (type === 7) sps = nal;
        else if (type === 8) pps = nal;
        else if (units.length > 0) {
            units[units.length - 1].nals.push(nal);
            if (type === 5) units[units.length - 1].key = true;
        }
    }
    assert.ok(sps && pps);
    const avcC = Buffer.concat([Buffer.from([1, sps[1], sps[2], sps[3], 0xff, 0xe1, sps.length >> 8, sps.length & 255]), sps, Buffer.from([1, pps.length >> 8, pps.length & 255]), pps]);
    const audioBytes = await fs.readFile(aac);
    const audioFrames: Buffer[] = [];
    for (let offset = 0; offset + 7 <= audioBytes.length;) {
        const length = ((audioBytes[offset + 3] & 3) << 11) | (audioBytes[offset + 4] << 3) | (audioBytes[offset + 5] >> 5);
        audioFrames.push(audioBytes.subarray(offset + ((audioBytes[offset + 1] & 1) ? 7 : 9), offset + length));
        offset += length;
    }
    const root = await tempDir('ffrec');
    const store = new MediaStore(root, 1024 * 1024 * 1024);
    const recorder = new CameraRecorder({ store, runId: RUN, mac: MAC, generation: () => GEN, now: () => Date.UTC(2026, 10, 5, 10, 0, 0) });
    recorder.start({ video: { width: 640, height: 360, avcC }, audio: { sampleRate: 48000, channels: 1, asc: aacLcAudioSpecificConfig(48000, 1) } });
    const chunks = units.map((unit, index) => ({
        kind: 'video' as const,
        keyframe: unit.key,
        timestampUs: 1_000_000 + Math.round(index * 1_000_000 / 30),
        durationUs: 33_333,
        data: Buffer.concat(unit.nals.flatMap((nal) => [Buffer.from([nal.length >>> 24, (nal.length >>> 16) & 255, (nal.length >>> 8) & 255, nal.length & 255]), nal])),
    }));
    const audio = audioFrames.map((frame, index) => ({
        kind: 'audio' as const,
        keyframe: true,
        timestampUs: 1_000_000 + Math.round(index * 1024 * 1_000_000 / 48000),
        durationUs: Math.round(1024 * 1_000_000 / 48000),
        data: frame,
    }));
    recorder.push([...chunks, ...audio].sort((left, right) => left.timestampUs - right.timestampUs));
    await recorder.stop();
    const [file] = await listFiles(root);
    const recorded = path.join(root, file);
    const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height,sample_rate', '-of', 'csv=p=0', recorded]).toString();
    assert.match(probe, /h264,640,360/);
    assert.match(probe, /aac,48000/);
    execFileSync('ffmpeg', ['-v', 'error', '-i', recorded, '-f', 'null', '-']);
});
