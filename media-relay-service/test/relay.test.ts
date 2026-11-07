import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import WebSocket from 'ws';
import { SessionAuthorizer, type MediaSessionProjection } from '../src/auth';
import { MediaRelay } from '../src/relay';
import { FRAME_FETCH_DATA, FRAME_FRAGMENT, FRAME_INIT, INGEST_PROTOCOL } from '../src/protocol';
import { buildInitSegment, buildMediaFragment } from '../../device-simulator/backend/src/media/fmp4';

const MAC = 'AA:BB:CC:DD:EE:01';
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const token = (label: string) => `${label}-token-0123456789abcdef`;

const init = buildInitSegment({ width: 640, height: 360, avcC: Uint8Array.of(1, 0x42, 0xe0, 0x1e, 0xff, 0xe1, 0, 0, 0) });
const fragment = (seq: number) => buildMediaFragment(seq, [{
    trackId: 1,
    baseDecodeTime: seq * 180000,
    samples: Array.from({ length: 60 }, (_, index) => ({ data: new Uint8Array(50).fill(seq), duration: 3000, keyframe: index === 0 })),
}]);
const frame = (type: number, data: Uint8Array) => Buffer.concat([Buffer.of(type), Buffer.from(data)]);

const setup = async (overrides: Partial<ConstructorParameters<typeof MediaRelay>[0]> = {}) => {
    const sessions = new Map<string, MediaSessionProjection>();
    const add = (resource: 'live_stream' | 'recording_playback', status: 'requested' | 'ready' = 'ready') => {
        const id = crypto.randomUUID();
        const access = token(`access${sessions.size}`);
        const ingest = token(`ingest${sessions.size}`);
        sessions.set(id, {
            session_id: id, device_id: 'dev-1', device_mac: MAC, instance_id: 'camera', resource_id: resource,
            resource_kind: 'video_stream', status, access_token_hash: hash(access), ingest_token_hash: hash(ingest),
            expires_at: new Date(Date.now() + 300_000).toISOString(),
        });
        return { id, access, ingest };
    };
    const authorizer = new SessionAuthorizer({ get: async (id) => sessions.get(id) ?? null }, 0);
    const relay = new MediaRelay({ authorizer, sweepIntervalMs: 50, firstFragmentWaitMs: 1500, ...overrides });
    await new Promise<void>((resolve) => relay.server.listen(0, '127.0.0.1', resolve));
    const port = (relay.server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const connect = async (hello: Record<string, unknown>) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ingest`);
        const messages: any[] = [];
        const waiters: Array<() => void> = [];
        ws.on('message', (data, binary) => {
            if (!binary) messages.push(JSON.parse(data.toString()));
            waiters.splice(0).forEach((wake) => wake());
        });
        const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
        await new Promise((resolve) => ws.on('open', resolve));
        ws.send(JSON.stringify({ type: 'hello', protocol: INGEST_PROTOCOL, mac: MAC, ...hello }));
        const next = async (type: string, timeoutMs = 2000) => {
            const deadline = Date.now() + timeoutMs;
            for (;;) {
                const found = messages.find((message) => message.type === type);
                if (found) {
                    messages.splice(messages.indexOf(found), 1);
                    return found;
                }
                if (Date.now() > deadline) throw new Error(`No ${type} message`);
                await new Promise<void>((resolve) => { waiters.push(resolve); setTimeout(resolve, 50); });
            }
        };
        return { ws, next, closed, messages };
    };
    return { relay, add, connect, base, sessions };
};

test('live: ingest token is checked, viewers get a shared HLS playlist of the camera', async () => {
    const { relay, add, connect, base, sessions } = await setup();
    const first = add('live_stream');
    const bad = await connect({ session_id: first.id, ingest_token: token('wrong'), kind: 'live' });
    assert.equal((await bad.next('error')).code, 'INGEST_FORBIDDEN');
    assert.equal(await bad.closed, 4003);

    const camera = await connect({ session_id: first.id, ingest_token: first.ingest, kind: 'live' });
    assert.equal((await camera.next('ready')).session_id, first.id);
    camera.ws.send(frame(FRAME_INIT, init));
    for (let seq = 0; seq < 3; seq += 1) camera.ws.send(frame(FRAME_FRAGMENT, fragment(seq)));

    const playlistUrl = `${base}/v1/sessions/${first.id}/${first.access}/index.m3u8`;
    const response = await fetch(playlistUrl);
    assert.equal(response.status, 200);
    const playlist = await response.text();
    assert.match(playlist, /#EXT-X-MAP:URI="live\/init-1\.mp4"/);
    assert.match(playlist, /#EXTINF:2\.000,\nlive\/0\.m4s/);
    assert.equal((await fetch(`${base}/v1/sessions/${first.id}/${first.access}/live/init-1.mp4`)).headers.get('content-length'), String(init.byteLength));
    const segment = new Uint8Array(await (await fetch(`${base}/v1/sessions/${first.id}/${first.access}/live/2.m4s`)).arrayBuffer());
    assert.deepEqual(segment, fragment(2));

    // A second viewer (its own session) shares the same camera ingest.
    const second = add('live_stream');
    assert.equal((await fetch(`${base}/v1/sessions/${second.id}/${second.access}/index.m3u8`)).status, 200);
    let viewers = await camera.next('viewers');
    while (viewers.count < 2) viewers = await camera.next('viewers');
    assert.equal(viewers.count, 2);

    assert.equal((await fetch(`${base}/v1/sessions/${first.id}/${second.access}/index.m3u8`)).status, 403);
    const pending = add('live_stream', 'requested');
    assert.equal((await fetch(`${base}/v1/sessions/${pending.id}/${pending.access}/index.m3u8`)).status, 503);

    relay.revoke([first.id]);
    sessions.delete(first.id);
    assert.equal((await fetch(playlistUrl)).status, 403);
    camera.ws.close();
    await relay.close();
});

test('live: the camera is told to stop when nobody watches', async () => {
    const { relay, add, connect, base } = await setup({ liveIdleStopMs: 200, liveStartGraceMs: 300 });
    const session = add('live_stream');
    const camera = await connect({ session_id: session.id, ingest_token: session.ingest, kind: 'live' });
    await camera.next('ready');
    camera.ws.send(frame(FRAME_INIT, init));
    camera.ws.send(frame(FRAME_FRAGMENT, fragment(0)));
    camera.ws.send(frame(FRAME_FRAGMENT, fragment(1)));
    assert.equal((await fetch(`${base}/v1/sessions/${session.id}/${session.access}/index.m3u8`)).status, 200);
    assert.equal((await camera.next('stop', 3000)).reason, 'no_viewers');
    await camera.closed;
    assert.equal(relay.stats().live_cameras, 0);
    await relay.close();
});

test('playback: VOD playlist from the camera file list, files fetched on demand without their init', async () => {
    const { relay, add, connect, base } = await setup();
    const session = add('recording_playback');
    const camera = await connect({ session_id: session.id, ingest_token: session.ingest, kind: 'playback' });
    await camera.next('ready');
    const file = Buffer.concat([Buffer.from(init), Buffer.from(fragment(0)), Buffer.from(fragment(1))]);
    const files: Record<string, Buffer> = { '20261105-120000': file, '20261105-120100': file, '20261105-121000': file };
    camera.ws.on('message', (data, binary) => {
        if (binary) return;
        const message = JSON.parse(data.toString());
        if (message.type !== 'fetch') return;
        const source = files[message.segment_id];
        const end = message.length === null ? source.length : message.offset + message.length;
        const body = source.subarray(message.offset, end);
        for (let offset = 0; offset < body.length; offset += 100) {
            const header = Buffer.alloc(5);
            header[0] = FRAME_FETCH_DATA;
            header.writeUInt32BE(message.request_id, 1);
            camera.ws.send(Buffer.concat([header, body.subarray(offset, offset + 100)]));
        }
        camera.ws.send(JSON.stringify({ type: 'fetch_done', request_id: message.request_id }));
    });
    const entry = (id: string, start: string, end: string) => ({ id, start, end, size: file.length, init_length: init.byteLength, init_id: 'init-a' });
    camera.ws.send(JSON.stringify({
        type: 'segment_list',
        segments: [
            entry('20261105-120000', '2026-11-05T12:00:00.000Z', '2026-11-05T12:01:00.000Z'),
            entry('20261105-120100', '2026-11-05T12:01:00.000Z', '2026-11-05T12:02:00.000Z'),
            entry('20261105-121000', '2026-11-05T12:10:00.000Z', '2026-11-05T12:10:30.000Z'),
        ],
    }));
    const root = `${base}/v1/sessions/${session.id}/${session.access}`;
    const playlist = await (await fetch(`${root}/index.m3u8`)).text();
    assert.match(playlist, /#EXT-X-PLAYLIST-TYPE:VOD/);
    assert.match(playlist, /#EXT-X-TARGETDURATION:60/);
    assert.equal(playlist.match(/#EXT-X-DISCONTINUITY/g)?.length, 1); // the 8-minute gap
    assert.match(playlist, /#EXT-X-PROGRAM-DATE-TIME:2026-11-05T12:10:00.000Z\n#EXTINF:30\.000,\nrec\/20261105-121000\/media\.m4s/);
    assert.match(playlist, /#EXT-X-ENDLIST/);
    const initBytes = new Uint8Array(await (await fetch(`${root}/rec/20261105-120000/init.mp4`)).arrayBuffer());
    assert.deepEqual(initBytes, init);
    const media = await fetch(`${root}/rec/20261105-120100/media.m4s`);
    assert.equal(media.status, 200);
    assert.deepEqual(new Uint8Array(await media.arrayBuffer()), new Uint8Array(file.subarray(init.byteLength)));
    assert.equal((await fetch(`${root}/rec/20261105-999999/media.m4s`)).status, 404);
    relay.revoke([session.id]);
    assert.equal((await camera.next('stop')).reason, 'session_revoked');
    await relay.close();
});
