import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { SessionAuthorizer, type MediaSessionProjection } from '../src/auth';
import { MediaRelay } from '../src/relay';
import { aacLcAudioSpecificConfig } from '../../device-simulator/backend/src/media/fmp4';
import { MediaStore } from '../../device-simulator/backend/src/media/media-store';
import { VirtualSecurityCamera } from '../../device-simulator/backend/src/runtime/security-camera';
import { fakeAvcC, syntheticStream } from '../../device-simulator/backend/test/media-helpers';

/**
 * Virtual camera (Simulator firmware) + media relay, end to end: the camera
 * dials out with the ingest token from the operation context, the viewer
 * reads HLS with its access token, exactly as the app will.
 */
const MAC = 'AA:BB:CC:DD:EE:42';
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

test('virtual camera streams live HLS and serves its recordings through the relay', async () => {
    const sessions = new Map<string, MediaSessionProjection>();
    const relay = new MediaRelay({
        authorizer: new SessionAuthorizer({ get: async (id) => sessions.get(id) ?? null }, 0),
        sweepIntervalMs: 100,
        firstFragmentWaitMs: 3000,
    });
    await new Promise<void>((resolve) => relay.server.listen(0, '127.0.0.1', resolve));
    const port = (relay.server.address() as AddressInfo).port;
    const newSession = (resource: string) => {
        const id = crypto.randomUUID();
        const access = crypto.randomBytes(32).toString('base64url');
        const ingest = crypto.randomBytes(32).toString('base64url');
        sessions.set(id, {
            session_id: id, device_id: 'owner-1', device_mac: MAC, instance_id: 'camera', resource_id: resource,
            resource_kind: 'video_stream', status: 'requested', access_token_hash: hash(access),
            ingest_token_hash: hash(ingest), expires_at: new Date(Date.now() + 300_000).toISOString(),
        });
        const context = {
            resource_session_id: id,
            media_ingest_url: `ws://127.0.0.1:${port}/v1/ingest`,
            media_ingest_token: ingest,
            media_profile_id: 'h264_aac_cmaf_v1',
        };
        return { id, access, context, markReady: () => { sessions.get(id)!.status = 'ready'; } };
    };

    const store = new MediaStore(await fs.mkdtemp(path.join(os.tmpdir(), 'relay-e2e-')), 1024 ** 3);
    const reportedSyncs: number[] = [];
    const camera = new VirtualSecurityCamera({
        mac: MAC,
        runId: 'run-e2e',
        product: { capability_instances: [{ instance_id: 'camera', capability_id: 'camera_stream' }, { instance_id: 'recording', capability_id: 'video_recording' }] } as any,
        assignment: () => ({ members: [{ mac: MAC, device_id: 'owner-1' }] } as any),
        claimedDeviceId: async () => null,
        requestReportedSync: () => reportedSyncs.push(Date.now()),
        emitEvent: async () => undefined,
        log: () => undefined,
    }, store);
    await camera.startSource({
        sessionId: 'webcam-session-1',
        video: { codec: 'avc1.42E01F', width: 640, height: 360, framerate: 30, avcC: fakeAvcC },
        audio: { codec: 'mp4a.40.2', sampleRate: 48000, channels: 1, asc: aacLcAudioSpecificConfig(48000, 1) },
    });

    // Live: the operation ACK comes only after the relay accepted the ingest.
    const live = newSession('live_stream');
    const outcome = await camera.handleOperation({ instance_id: 'camera', operation_name: 'create_stream_session', input: {}, context: live.context });
    assert.ok(outcome);
    assert.equal(camera.reported().camera.camera_state, 'streaming');
    live.markReady();
    const stream = syntheticStream(8, 1_000_000, 500);
    camera.pushChunks('webcam-session-1', stream.slice(0, Math.floor(stream.length / 2)));
    camera.pushChunks('webcam-session-1', stream.slice(Math.floor(stream.length / 2)));
    const base = `http://127.0.0.1:${port}/v1/sessions/${live.id}/${live.access}`;
    const playlist = await (await fetch(`${base}/index.m3u8`)).text();
    assert.match(playlist, /#EXT-X-MAP:URI="live\/init-1\.mp4"/);
    const firstSegment = /live\/(\d+)\.m4s/.exec(playlist)![0];
    const segment = await fetch(`${base}/${firstSegment}`);
    assert.equal(segment.status, 200);
    assert.ok((await segment.arrayBuffer()).byteLength > 1000);

    // A second viewer reuses the open ingest (no second connection).
    const second = newSession('live_stream');
    await camera.handleOperation({ instance_id: 'camera', operation_name: 'create_stream_session', input: {}, context: second.context });
    second.markReady();
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/sessions/${second.id}/${second.access}/index.m3u8`)).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(camera.reported().camera.live_viewers, 2);

    await camera.stopSource('webcam-session-1');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(camera.reported().camera.camera_state, 'unavailable');
    const recorded = camera.segments();
    assert.ok(recorded.length >= 1);

    // Playback of the recording through the relay.
    const playback = newSession('recording_playback');
    const result = await camera.handleOperation({
        instance_id: 'recording',
        operation_name: 'create_playback_session',
        input: { from: new Date(recorded[0].startMs - 1000).toISOString() },
        context: playback.context,
    });
    assert.equal((result?.details as any).segments, recorded.length);
    playback.markReady();
    const root = `http://127.0.0.1:${port}/v1/sessions/${playback.id}/${playback.access}`;
    const vod = await (await fetch(`${root}/index.m3u8`)).text();
    assert.match(vod, /#EXT-X-ENDLIST/);
    const mediaPath = /rec\/[^\n]+\/media\.m4s/.exec(vod)![0];
    const initPath = /rec\/[^"]+\/init\.mp4/.exec(vod)![0];
    const file = await fs.readFile(recorded[0].path);
    const init = new Uint8Array(await (await fetch(`${root}/${initPath}`)).arrayBuffer());
    const media = new Uint8Array(await (await fetch(`${root}/${mediaPath}`)).arrayBuffer());
    assert.equal(init.byteLength + media.byteLength, file.byteLength);
    assert.deepEqual(Buffer.concat([Buffer.from(init), Buffer.from(media)]), file);

    relay.revoke([playback.id]);
    assert.equal((await fetch(`${root}/index.m3u8`)).status, 403);
    await camera.dispose();
    await relay.close();
});
