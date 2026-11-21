import './setup-env';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { env } from '../src/config/env';
import voiceRoutes from '../src/modules/voice/routes';
import { REDIS_CHANNELS } from '../../shared/constants';
import { createTestDatabase, skipWithoutDatabase, TestDatabase } from './helpers/testDatabase';
import { buildTestApp, recordPublishes, signUp, SignedInUser } from './helpers/testApp';

let db: TestDatabase;
let app: FastifyInstance;
let voice: http.Server;

interface Seen { method: string; path: string; token: string | undefined; body: string }
const seen: Seen[] = [];
let reply: (request: Seen) => { status: number; body?: unknown } = () => ({ status: 200, body: {} });

/** A stand-in for voice-service: records requests, answers what the test says. */
function startVoiceService(): Promise<string> {
    voice = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const request = {
                method: req.method ?? '', path: req.url ?? '',
                token: req.headers['x-voice-token'] as string | undefined, body: Buffer.concat(chunks).toString('latin1'),
            };
            seen.push(request);
            const answer = reply(request);
            res.writeHead(answer.status, { 'content-type': 'application/json' });
            res.end(answer.body === undefined ? '' : JSON.stringify(answer.body));
        });
    });
    return new Promise(resolve => voice.listen(0, '127.0.0.1', () => {
        resolve(`http://127.0.0.1:${(voice.address() as AddressInfo).port}`);
    }));
}

function multipart(parts: Array<{ name: string; file?: Buffer; value?: string }>) {
    const boundary = '----voice-test-boundary';
    const chunks: Buffer[] = [];
    for (const part of parts) {
        const head = part.file
            ? `Content-Disposition: form-data; name="${part.name}"; filename="${part.name}.wav"\r\nContent-Type: audio/wav\r\n\r\n`
            : `Content-Disposition: form-data; name="${part.name}"\r\n\r\n`;
        chunks.push(Buffer.from(`--${boundary}\r\n${head}`), part.file ?? Buffer.from(part.value ?? ''), Buffer.from('\r\n'));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

const audio = (size = 2000) => Buffer.alloc(size, 7);

function upload(user: SignedInUser, url: string, parts: Array<{ name: string; file?: Buffer; value?: string }>) {
    const body = multipart(parts);
    return app.inject({
        method: 'POST', url, payload: body.payload,
        headers: { ...user.headers, 'content-type': body.contentType },
    });
}

const verifyResult = (accepted: boolean) => ({
    accepted, reason: accepted ? null : 'not_matched',
    scores: { similarity: accepted ? 0.9 : 0.2 }, thresholds: {}, gallery_updated: false,
});

test.describe('voice profile', { skip: skipWithoutDatabase }, () => {
    test.before(async () => {
        db = await createTestDatabase();
        env.VOICE_SERVICE_URL = await startVoiceService();
        env.VOICE_SERVICE_TOKEN = 'gateway-voice-token-123';
        app = await buildTestApp(db.pool, [voiceRoutes]);
    });
    test.after(async () => {
        await app?.close();
        await new Promise(resolve => voice?.close(resolve));
        await db?.drop();
    });
    test.beforeEach(() => {
        seen.length = 0;
        reply = () => ({ status: 200, body: {} });
    });

    test('profile is read and enrolled through voice-service with the shared token', async () => {
        const user = await signUp(app);
        reply = () => ({ status: 404, body: { error: { code: 'VOICE_PROFILE_NOT_FOUND', message: 'x', details: {} } } });
        const empty = await app.inject({ method: 'GET', url: '/voice/profile', headers: user.headers });
        assert.equal(empty.statusCode, 200, empty.body);
        assert.deepEqual(empty.json(), { success: true, profile: null, lock: { locked_until: null, failures_left: 5 } });
        assert.equal(seen[0].path, `/v1/profiles/${user.id}`);
        assert.equal(seen[0].token, 'gateway-voice-token-123');

        const files = [{ name: 'ambient', file: audio() }, ...[0, 1, 2].map(() => ({ name: 'samples', file: audio() }))];
        const noConsent = await upload(user, '/voice/profile', files);
        assert.equal(noConsent.json().error.code, 'VOICE_CONSENT_REQUIRED');
        assert.equal(seen.length, 1);

        reply = () => ({ status: 200, body: { enrolled: true, templates: { enroll: 3 } } });
        const enrolled = await upload(user, '/voice/profile', [{ name: 'consent', value: 'true' }, ...files]);
        assert.equal(enrolled.statusCode, 200, enrolled.body);
        assert.equal(enrolled.json().profile.templates.enroll, 3);
        const forwarded = seen[seen.length - 1];
        assert.equal(forwarded.method, 'PUT');
        assert.equal(forwarded.body.match(/name="samples"/g)?.length, 3);
        assert.match(forwarded.body, /name="consent"\r\n\r\ntrue/);
    });

    test('uploads are checked before reaching voice-service', async () => {
        const user = await signUp(app);
        const missing = await upload(user, '/voice/verify', [{ name: 'other', file: audio() }]);
        assert.equal(missing.json().error.code, 'VOICE_BAD_REQUEST');
        const noFile = await upload(user, '/voice/verify', [{ name: 'note', value: 'x' }]);
        assert.equal(noFile.json().error.code, 'VOICE_BAD_REQUEST');
        const tooBig = await upload(user, '/voice/verify', [{ name: 'audio', file: audio(1024 * 1024 + 10) }]);
        assert.equal(tooBig.statusCode, 413);
        assert.equal(tooBig.json().error.code, 'VOICE_FILE_TOO_LARGE');
        const json = await app.inject({ method: 'POST', url: '/voice/verify', headers: user.headers, payload: { a: 1 } });
        assert.equal(json.json().error.code, 'VOICE_BAD_REQUEST');
        assert.equal(seen.length, 0);
    });

    test('five rejections lock voice verification for 15 minutes and notify the account', async () => {
        const user = await signUp(app);
        const published = recordPublishes(app);

        reply = () => ({ status: 422, body: { error: { code: 'VOICE_TOO_NOISY', message: 'Xung quanh quá ồn', details: {} } } });
        const noisy = await upload(user, '/voice/verify', [{ name: 'audio', file: audio() }]);
        assert.equal(noisy.statusCode, 422);
        assert.equal(noisy.json().error.code, 'VOICE_TOO_NOISY');

        reply = () => ({ status: 200, body: verifyResult(false) });
        for (let i = 1; i <= 2; i += 1) {
            const response = await upload(user, '/voice/verify', [{ name: 'audio', file: audio() }]);
            assert.equal(response.statusCode, 200, response.body);
            assert.equal(response.json().result.accepted, false);
            assert.equal(response.json().lock.failures_left, 5 - i); // the noisy recording did not count
        }
        reply = () => ({ status: 200, body: verifyResult(true) });
        const owner = await upload(user, '/voice/verify', [{ name: 'audio', file: audio() }]);
        assert.equal(owner.json().lock.failures_left, 5); // a match resets the count

        // (10 verifications per minute are allowed: this test uses all of them.)
        reply = () => ({ status: 200, body: verifyResult(false) });
        let last;
        for (let i = 0; i < 5; i += 1) last = await upload(user, '/voice/verify', [{ name: 'audio', file: audio() }]);
        assert.equal(last!.json().lock.failures_left, 0);
        assert.ok(Date.parse(last!.json().lock.locked_until) > Date.now() + 14 * 60_000);

        const calls = seen.length;
        const locked = await upload(user, '/voice/verify', [{ name: 'audio', file: audio() }]);
        assert.equal(locked.statusCode, 423);
        assert.equal(locked.json().error.code, 'VOICE_LOCKED');
        assert.ok(locked.json().error.details.locked_until);
        const sample = await upload(user, '/voice/samples', [{ name: 'audio', file: audio() }]);
        assert.equal(sample.statusCode, 423);
        assert.equal(seen.length, calls);

        const notices = (await db.pool.query(
            'SELECT kind, title FROM account_notifications WHERE account_id = $1', [user.id],
        )).rows;
        assert.deepEqual(notices, [{ kind: 'security', title: 'Giọng nói tạm khóa' }]);
        const event = published.find(item => item.channel === REDIS_CHANNELS.ACCOUNT_EVENT);
        assert.equal(event?.payload.event, 'notification_created');
        assert.equal(event?.payload.data.notification.kind, 'security');
        assert.equal(event?.payload.data.notification.severity, 'warning');

        const state = await app.inject({ method: 'GET', url: '/voice/profile', headers: user.headers });
        assert.equal(state.json().lock.failures_left, 0);
    });

    test('quality errors keep which recording failed', async () => {
        const user = await signUp(app);
        reply = () => ({ status: 422, body: { error: { code: 'VOICE_TOO_SHORT', message: 'Câu nói quá ngắn', details: { sample: 1 } } } });
        const response = await upload(user, '/voice/calibrate', [0, 1, 2].map(() => ({ name: 'samples', file: audio() })));
        assert.equal(response.statusCode, 422);
        assert.deepEqual(response.json().error, { code: 'VOICE_TOO_SHORT', message: 'Câu nói quá ngắn', details: { sample: 1 } });
    });

    test('deleting the voiceprint needs the password and clears the lock', async () => {
        const user = await signUp(app);
        await app.redis.set(`voice:lock:${user.id}`, '1', 'EX', 900);
        const wrong = await app.inject({
            method: 'DELETE', url: '/voice/profile', headers: user.headers, payload: { password: 'not it' },
        });
        assert.equal(wrong.statusCode, 403);
        assert.equal(seen.length, 0);

        reply = () => ({ status: 204 });
        const deleted = await app.inject({
            method: 'DELETE', url: '/voice/profile', headers: user.headers, payload: { password: user.password },
        });
        assert.equal(deleted.statusCode, 200, deleted.body);
        assert.equal(seen[0].method, 'DELETE');
        assert.equal(await app.redis.get(`voice:lock:${user.id}`), null);
    });

    test('an unreachable or unconfigured voice-service is 503', async () => {
        const user = await signUp(app);
        reply = () => ({ status: 500, body: { detail: 'boom' } });
        const failing = await app.inject({ method: 'GET', url: '/voice/profile', headers: user.headers });
        assert.equal(failing.statusCode, 503);
        assert.equal(failing.json().error.code, 'VOICE_UNAVAILABLE');

        const token = env.VOICE_SERVICE_TOKEN;
        env.VOICE_SERVICE_TOKEN = '';
        try {
            const off = await upload(user, '/voice/verify', [{ name: 'audio', file: audio() }]);
            assert.equal(off.statusCode, 503);
        } finally {
            env.VOICE_SERVICE_TOKEN = token;
        }
    });
});
