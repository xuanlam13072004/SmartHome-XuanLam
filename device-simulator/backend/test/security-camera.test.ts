import assert from 'node:assert/strict';
import test from 'node:test';
import { aacLcAudioSpecificConfig } from '../src/media/fmp4';
import { MediaStore } from '../src/media/media-store';
import { DeviceOperationRejection } from '../src/runtime/camera-controller';
import { mergeRanges, VirtualSecurityCamera, type CameraEventDraft } from '../src/runtime/security-camera';
import type { TopologyAssignment } from '../src/runtime/topology';
import { fakeAvcC, syntheticStream, tempDir } from './media-helpers';

const product = {
    product_id: 'prod_security_camera',
    capability_instances: [
        { instance_id: 'camera', capability_id: 'camera_stream' },
        { instance_id: 'recording', capability_id: 'video_recording' },
        { instance_id: 'system', capability_id: 'system_diagnostics' },
    ],
} as any;

const assignmentFor = (mac: string, deviceId: string): TopologyAssignment => ({
    schema: 'device.topology.assignment.v2',
    network_id: 'net-1',
    topology_epoch: 2,
    topology_state: 'stable',
    role: 'hub',
    join_rank: 0,
    active_hub_mac: mac,
    transport_mode: 'hub',
    members: [{ device_id: deviceId, mac, join_rank: 0, role: 'hub' }],
});

const setup = async (options: { mac?: string; deviceId?: string | null; store?: MediaStore; now?: () => number } = {}) => {
    const mac = options.mac || 'AA:BB:CC:00:00:01';
    const store = options.store || new MediaStore(await tempDir('cam'), 1024 * 1024 * 1024);
    const events: CameraEventDraft[] = [];
    let syncs = 0;
    let assignment = options.deviceId === null ? undefined : assignmentFor(mac, options.deviceId || 'owner-a');
    const camera = new VirtualSecurityCamera({
        mac,
        runId: 'run-cam',
        product,
        assignment: () => assignment,
        claimedDeviceId: async () => null,
        requestReportedSync: () => { syncs += 1; },
        emitEvent: async (draft) => { events.push(draft); },
        log: () => undefined,
    }, store, options.now);
    return {
        camera,
        store,
        events,
        mac,
        syncs: () => syncs,
        setAssignment: (next: TopologyAssignment) => { assignment = next; },
    };
};

const startSource = (camera: VirtualSecurityCamera, sessionId = 'session-0001') => camera.startSource({
    sessionId,
    video: { codec: 'avc1.42E01F', width: 1280, height: 720, framerate: 30, avcC: fakeAvcC },
    audio: { codec: 'mp4a.40.2', sampleRate: 48000, channels: 1, asc: aacLcAudioSpecificConfig(48000, 1) },
});

const rejects = async (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: unknown) => (
    error instanceof DeviceOperationRejection && error.reasonCode === code
));

test('camera without a webcam reports unavailable and rejects live sessions', async () => {
    const { camera } = await setup();
    const reported = camera.reported();
    assert.equal(reported.camera.camera_state, 'unavailable');
    assert.equal(reported.camera.audio_state, 'unavailable');
    assert.equal(reported.camera.video_resolution, null);
    assert.equal(reported.recording.recording_state, 'stopped');
    assert.equal(reported.recording.storage_total_bytes, 1024 * 1024 * 1024);
    await rejects(camera.handleOperation({ instance_id: 'camera', operation_name: 'create_stream_session', input: {} }), 'CAMERA_UNAVAILABLE');
    await camera.dispose();
});

test('webcam source records, lists and deletes real recordings', async () => {
    let wall = Date.UTC(2026, 10, 5, 12, 0, 30);
    const { camera, events } = await setup({ now: () => wall });
    await startSource(camera);
    assert.equal(camera.reported().camera.camera_state, 'idle');
    assert.equal(camera.reported().camera.audio_state, 'ok');
    assert.equal(camera.reported().camera.video_resolution, '1280x720');
    camera.pushChunks('session-0001', syntheticStream(40));
    assert.throws(() => camera.pushChunks('other-session', []), /not active/);
    await camera.stopSource('session-0001');

    const listed = await camera.handleOperation({
        instance_id: 'recording',
        operation_name: 'list_recordings',
        input: { from: '2026-11-05T11:00:00.000Z', to: '2026-11-05T13:00:00.000Z' },
    });
    assert.deepEqual(listed?.details, {
        ranges: [{ start: '2026-11-05T12:00:30.000Z', end: '2026-11-05T12:01:10.000Z' }],
        next_cursor: null,
    });
    const reported = camera.reported().recording;
    assert.equal(reported.oldest_recording_at, '2026-11-05T12:00:30.000Z');
    assert.ok(Number(reported.storage_used_bytes) > 0);

    await rejects(camera.handleOperation({
        instance_id: 'recording', operation_name: 'create_playback_session', input: { from: '2026-11-05T09:00:00.000Z', to: '2026-11-05T10:00:00.000Z' },
    }), 'RECORDING_UNAVAILABLE');
    await rejects(camera.handleOperation({
        instance_id: 'recording', operation_name: 'create_playback_session', input: { from: '2026-11-05T12:00:40.000Z' },
    }), 'MEDIA_INGEST_UNAVAILABLE');

    const deleted = await camera.handleOperation({
        instance_id: 'recording',
        operation_name: 'delete_recordings',
        input: { from: '2026-11-05T12:00:00.000Z', to: '2026-11-05T12:00:59.000Z' },
    });
    assert.equal((deleted?.details as any).deleted_segments, 1);
    assert.deepEqual(camera.segments().map((segment) => segment.id), ['20261105-120100']);
    assert.equal(events.at(-1)?.event_name, 'recordings_deleted');
    await rejects(camera.handleOperation({ instance_id: 'recording', operation_name: 'delete_recordings', input: {} }), 'INVALID_INPUT');
    const all = await camera.handleOperation({ instance_id: 'recording', operation_name: 'delete_recordings', input: { all: true } });
    assert.equal((all?.details as any).deleted_segments, 1);
    assert.equal(camera.reported().recording.oldest_recording_at, null);
    wall += 0;
    await camera.dispose();
});

test('a new owner generation wipes the previous owner recordings first', async () => {
    const shared = await setup({ deviceId: 'owner-a', now: () => Date.UTC(2026, 10, 5, 13, 0, 0) });
    await startSource(shared.camera);
    shared.camera.pushChunks('session-0001', syntheticStream(6));
    await shared.camera.stopSource();
    assert.equal(shared.camera.segments().length, 1);

    shared.setAssignment(assignmentFor(shared.mac, 'owner-b'));
    await shared.camera.onAssignment(assignmentFor(shared.mac, 'owner-b'));
    assert.deepEqual(shared.camera.segments(), []);
    assert.deepEqual(shared.store.generations('run-cam', shared.mac), []);
    const wiped = shared.events.find((event) => event.event_name === 'recordings_wiped');
    assert.deepEqual(wiped?.data, { reason: 'owner_changed', deleted_segments: 1 });
    await shared.camera.dispose();

    // A camera restarted under a different owner also wipes on boot.
    const first = await setup({ deviceId: 'owner-c', now: () => Date.UTC(2026, 10, 5, 14, 0, 0), store: shared.store, mac: 'AA:BB:CC:00:00:09' });
    await startSource(first.camera);
    first.camera.pushChunks('session-0001', syntheticStream(6));
    await first.camera.dispose();
    const rebooted = await setup({ deviceId: 'owner-d', store: shared.store, mac: 'AA:BB:CC:00:00:09' });
    await rebooted.camera.handleOperation({ instance_id: 'recording', operation_name: 'delete_recordings', input: { all: true } });
    assert.equal(rebooted.events[0]?.event_name, 'recordings_wiped');
    assert.deepEqual(shared.store.generations('run-cam', 'AA:BB:CC:00:00:09'), []);
    await rebooted.camera.dispose();
});

test('only one virtual camera holds the webcam unless the dashboard takes it over', async () => {
    const store = new MediaStore(await tempDir('excl'), 1024 * 1024 * 1024);
    const first = await setup({ store, mac: 'AA:BB:CC:00:00:11' });
    const second = await setup({ store, mac: 'AA:BB:CC:00:00:12' });
    await startSource(first.camera);
    await assert.rejects(startSource(second.camera), /Another virtual camera/);
    await second.camera.startSource({
        sessionId: 'session-0002',
        video: { codec: 'avc1.42E01F', width: 640, height: 360, framerate: 30, avcC: fakeAvcC },
        audio: null,
    }, true);
    assert.equal(first.camera.sourceActive, false);
    assert.equal(second.camera.reported().camera.audio_state, 'unavailable');
    await first.camera.dispose();
    await second.camera.dispose();
});

test('timeline ranges merge consecutive minutes and split real gaps', () => {
    const segment = (start: number, end: number) => ({ startMs: start, endMs: end } as any);
    assert.deepEqual(mergeRanges([segment(60_000, 120_000), segment(0, 60_000), segment(122_000, 180_000), segment(300_000, 360_000)]), [
        { startMs: 0, endMs: 180_000 },
        { startMs: 300_000, endMs: 360_000 },
    ]);
});

test('the minute still being recorded can be listed and played back seconds later', async () => {
    const wall = Date.UTC(2026, 10, 8, 9, 30, 10);
    const { camera } = await setup({ now: () => wall });
    await startSource(camera);
    camera.pushChunks('session-0001', syntheticStream(20));
    await (camera as any).recorder.idle();

    // The webcam is still on: the minute file is open, yet it is already listed.
    assert.equal(camera.segments().length, 0);
    const listed = await camera.handleOperation({
        instance_id: 'recording',
        operation_name: 'list_recordings',
        input: { from: '2026-11-08T09:00:00.000Z', to: '2026-11-08T10:00:00.000Z' },
    });
    const range = (listed?.details as any).ranges[0];
    assert.equal(range.start, '2026-11-08T09:30:10.000Z');
    assert.ok(Date.parse(range.end) >= Date.parse('2026-11-08T09:30:26.000Z'));

    // Playback serves the bytes written so far, also after the minute file is renamed.
    const snapshot = (camera as any).recordedSegments().at(-1);
    const frames: Uint8Array[] = [];
    const messages: any[] = [];
    const server = {
        connection: {
            isOpen: true,
            bufferedAmount: 0,
            sendFrame: (_kind: number, data: Uint8Array) => { frames.push(Buffer.from(data)); },
            sendJson: (message: unknown) => { messages.push(message); },
        },
        cancelled: new Set<number>(),
        snapshots: new Map([[snapshot.id, snapshot]]),
    };
    const fetchAll = async () => {
        frames.length = 0;
        await (camera as any).serveFetch(server, { type: 'fetch', request_id: 1, segment_id: snapshot.id, offset: 0, length: null });
        return frames.reduce((sum, frame) => sum + frame.byteLength, 0);
    };
    assert.equal(await fetchAll(), snapshot.size);
    await camera.stopSource('session-0001');
    assert.equal(camera.segments().length, 1);
    assert.equal(await fetchAll(), snapshot.size);
    assert.ok(messages.every((message) => message.type === 'fetch_done'));
    await camera.dispose();
});
