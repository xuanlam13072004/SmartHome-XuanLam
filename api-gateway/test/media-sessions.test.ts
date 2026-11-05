import './setup-env';
import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore - test double without type declarations
import RedisMock from 'ioredis-mock';
import {
    boundOperationResult,
    buildMediaLocator,
    createToken,
    hashToken,
    mediaSessionKey,
    revokeMediaSessions,
    updateMediaSessionProjection,
    writeMediaSessionProjection,
    MAX_OPERATION_RESULT_BYTES,
} from '../src/modules/device/mediaSessions';
import { resolveResourceLocator } from '../src/workers/operationStatusConsumer';
import { redactOperationForProjection } from '../src/workers/operationOutboxDispatcher';

test('media locator points at the relay session and never embeds a token', () => {
    assert.equal(
        buildMediaLocator('https://media.example.com/', 'sess-1'),
        'https://media.example.com/v1/sessions/sess-1/',
    );
});

test('tokens are random and stored only as SHA-256 hashes', () => {
    const first = createToken();
    const second = createToken();
    assert.notEqual(first.raw, second.raw);
    assert.equal(first.hash, hashToken(first.raw));
    assert.equal(first.hash.length, 64);
    assert.ok(!first.hash.includes(first.raw));
});

test('device ACK details become a bounded operation result', () => {
    assert.equal(boundOperationResult(undefined), null);
    assert.equal(boundOperationResult({}), null);
    assert.equal(boundOperationResult(['not', 'an', 'object']), null);
    const ranges = { ranges: [{ start: '2026-11-04T08:00:00Z', end: '2026-11-04T09:00:00Z' }] };
    assert.deepEqual(boundOperationResult(ranges), ranges);
    const huge = boundOperationResult({ blob: 'x'.repeat(MAX_OPERATION_RESULT_BYTES) });
    assert.equal(huge?.truncated, true);
});

test('video sessions always use the relay locator; other resources keep the device locator', () => {
    const fromDevice = { resource_locator: 'simulator://fake' };
    assert.deepEqual(
        resolveResourceLocator('video_stream', 's1', fromDevice, 'https://media.example.com'),
        { locator: 'https://media.example.com/v1/sessions/s1/', failureCode: '' },
    );
    assert.deepEqual(
        resolveResourceLocator('video_stream', 's1', fromDevice, undefined),
        { locator: null, failureCode: 'MEDIA_RELAY_NOT_CONFIGURED' },
    );
    assert.equal(resolveResourceLocator('snapshot', 's2', fromDevice).locator, 'simulator://fake');
    assert.equal(resolveResourceLocator('snapshot', 's2', {}).locator, null);
});

test('the realtime operation projection never carries the media ingest token', () => {
    const payload = { operation_id: 'op', context: { resource_session_id: 's', media_ingest_token: 'secret' } };
    const redacted = redactOperationForProjection(payload);
    assert.equal('media_ingest_token' in redacted.context, false);
    assert.equal(redacted.context.resource_session_id, 's');
    assert.equal(payload.context.media_ingest_token, 'secret');
    assert.equal(redactOperationForProjection({ operation_id: 'op2' }).operation_id, 'op2');
});

test('media session projection follows creation, readiness, renewal and revocation', async () => {
    const redis = new RedisMock();
    const published: Array<[string, string]> = [];
    const originalPublish = redis.publish.bind(redis);
    redis.publish = async (channel: string, message: string) => {
        published.push([channel, message]);
        return originalPublish(channel, message);
    };
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await writeMediaSessionProjection(redis, {
        session_id: 'sess-1',
        device_id: 'dev-1',
        device_mac: 'AA:BB:CC:00:00:01',
        instance_id: 'camera',
        resource_id: 'live_stream',
        resource_kind: 'video_stream',
        status: 'requested',
        access_token_hash: 'a'.repeat(64),
        ingest_token_hash: 'b'.repeat(64),
        expires_at: expiresAt,
    });
    assert.ok((await redis.pttl(mediaSessionKey('sess-1'))) > 0);

    const renewed = new Date(Date.now() + 300_000).toISOString();
    await updateMediaSessionProjection(redis, 'sess-1', { status: 'ready', expires_at: renewed });
    const stored = JSON.parse(await redis.get(mediaSessionKey('sess-1')));
    assert.equal(stored.status, 'ready');
    assert.equal(stored.expires_at, renewed);
    assert.ok((await redis.pttl(mediaSessionKey('sess-1'))) > 60_000);

    await revokeMediaSessions(redis, 'AA:BB:CC:00:00:01', ['sess-1']);
    assert.equal(await redis.get(mediaSessionKey('sess-1')), null);
    assert.equal(published.length, 1);
    assert.equal(published[0][0], 'media.session.revoked');
    assert.deepEqual(JSON.parse(published[0][1]).session_ids, ['sess-1']);

    await revokeMediaSessions(redis, 'AA:BB:CC:00:00:01', []);
    assert.equal(published.length, 1);
});
