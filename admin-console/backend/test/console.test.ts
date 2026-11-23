import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import fastify, { type FastifyInstance } from 'fastify';
import { buildConsole } from '../src/app';
import { loadConfig } from '../src/config';

process.env.NODE_ENV = 'test';

const KEY = 'k'.repeat(40);
const ROOT = 'A'.repeat(43);
const VIEWER = 'B'.repeat(43);
const NOBODY = 'C'.repeat(43);
const SIM_TOKEN = 'simulator-token-0123456789';

const staff = (permissions: string[], is_root = false) => ({
    id: 'id', email: 'x@xuanlam.vn', full_name: 'X', is_root, permissions, must_change_password: false,
});

interface Fakes {
    gateway: FastifyInstance;
    simulator: FastifyInstance;
    audits: any[];
    logouts: string[];
    seen: Record<string, any>;
}

async function fakes(): Promise<Fakes> {
    const audits: any[] = [];
    const logouts: string[] = [];
    const seen: Record<string, any> = {};
    const gateway = fastify();
    gateway.addHook('onRequest', async (request, reply) => {
        if (request.headers['x-admin-key'] !== KEY) return reply.status(401).send({ success: false, error: { code: 'ADMIN_KEY_INVALID' } });
    });
    gateway.post('/admin/staff/login', async (request, reply) => {
        const body = request.body as any;
        if (body.email !== 'root@xuanlam.vn' || body.password !== 'mat-khau-dung') {
            return reply.status(401).send({ success: false, error: { code: 'STAFF_INVALID_CREDENTIALS' } });
        }
        return { success: true, session_token: ROOT, expires_at: new Date(Date.now() + 12 * 3600_000).toISOString(), idle_minutes: 30, staff: staff([], true) };
    });
    gateway.get('/admin/staff/me', async (request, reply) => {
        const session = request.headers['x-staff-session'];
        const who = session === ROOT ? staff([], true) : session === VIEWER ? staff(['simulator.view']) : session === NOBODY ? staff(['overview.view']) : null;
        return who ? { success: true, staff: who } : reply.status(401).send({ success: false, error: { code: 'STAFF_SESSION_INVALID' } });
    });
    gateway.post('/admin/staff/logout', async (request) => {
        logouts.push(String(request.headers['x-staff-session']));
        return { success: true };
    });
    gateway.get('/admin/overview', async (request) => {
        seen.overview = { ...request.headers };
        return { success: true, accounts: { total: 7 } };
    });
    gateway.post('/admin/audit/simulator', async (request) => {
        audits.push({ body: request.body, session: request.headers['x-staff-session'] });
        return { success: true };
    });

    const simulator = fastify();
    simulator.removeAllContentTypeParsers();
    simulator.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => done(null, JSON.parse(String(body))));
    simulator.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 16 * 1024 * 1024 }, (_request, body, done) => done(null, body));
    simulator.get('/api/simulation-runs', async (request) => ({
        runs: [], authorization: request.headers.authorization, cookie: request.headers.cookie ?? null, query: request.query,
    }));
    simulator.post('/api/simulation-runs', async (request, reply) => reply.status(202).send({ run: { config: request.body } }));
    simulator.post('/api/devices/:mac/camera/chunks', async (request) => ({ bytes: (request.body as Buffer).length }));
    simulator.get('/api/events/stream', (_request, reply) => {
        reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
        reply.raw.write('data: {"type":"hello"}\n\n');
        reply.raw.end();
    });
    await gateway.listen({ port: 0, host: '127.0.0.1' });
    await simulator.listen({ port: 0, host: '127.0.0.1' });
    return { gateway, simulator, audits, logouts, seen };
}

const url = (app: FastifyInstance) => {
    const address = app.server.address();
    return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
};

test.describe('Admin Console backend', () => {
    let f: Fakes;
    let consoleApp: FastifyInstance;
    let staticDir: string;

    test.before(async () => {
        f = await fakes();
        staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'console-web-'));
        fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>Admin Console</title>');
        consoleApp = await buildConsole(loadConfig({
            ADMIN_API_KEY: KEY, GATEWAY_URL: url(f.gateway), SIMULATOR_URL: url(f.simulator),
            SIMULATOR_TOKEN: SIM_TOKEN, STATIC_DIR: staticDir,
        }));
    });
    test.after(async () => {
        await consoleApp?.close();
        await f?.gateway.close();
        await f?.simulator.close();
        fs.rmSync(staticDir, { recursive: true, force: true });
    });

    const cookieOf = (session: string) => ({ cookie: `sh_console=${session}`, 'x-console-request': '1' });

    test('signing in sets an httpOnly, same-site cookie; the token never reaches the page', async () => {
        const wrong = await consoleApp.inject({
            method: 'POST', url: '/api/session/login', headers: { 'x-console-request': '1' },
            payload: { email: 'root@xuanlam.vn', password: 'sai' },
        });
        assert.equal(wrong.statusCode, 401);
        assert.equal(wrong.headers['set-cookie'], undefined);

        const login = await consoleApp.inject({
            method: 'POST', url: '/api/session/login', headers: { 'x-console-request': '1' },
            payload: { email: 'root@xuanlam.vn', password: 'mat-khau-dung' },
        });
        assert.equal(login.statusCode, 200, login.body);
        const cookie = String(login.headers['set-cookie']);
        assert.match(cookie, new RegExp(`^sh_console=${ROOT};`));
        assert.match(cookie, /HttpOnly/);
        assert.match(cookie, /SameSite=Strict/);
        assert.ok(!login.body.includes(ROOT), 'the session token is only in the cookie');
        assert.equal(login.json().staff.is_root, true);

        const session = await consoleApp.inject({ method: 'GET', url: '/api/session', headers: cookieOf(ROOT) });
        assert.deepEqual([session.json().staff.is_root, session.json().simulator], [true, true]);
        assert.equal((await consoleApp.inject({ method: 'GET', url: '/api/session' })).statusCode, 401);
    });

    test('changes need the Console header (no cross-site requests)', async () => {
        const forged = await consoleApp.inject({ method: 'POST', url: '/api/simulator/simulation-runs', headers: { cookie: `sh_console=${ROOT}` }, payload: {} });
        assert.equal(forged.statusCode, 403);
        assert.equal(forged.json().error.code, 'CONSOLE_REQUEST_REQUIRED');
    });

    test('/api/admin goes to the Gateway with the server key and the session, never what the browser claims', async () => {
        const response = await consoleApp.inject({
            method: 'GET', url: '/api/admin/overview', headers: { ...cookieOf(ROOT), 'x-admin-key': 'forged', 'user-agent': 'Chrome' },
        });
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.json().accounts.total, 7);
        assert.equal(f.seen.overview['x-admin-key'], KEY);
        assert.equal(f.seen.overview['x-staff-session'], ROOT);
        assert.equal(f.seen.overview['x-staff-client'], 'Chrome');
        assert.equal(f.seen.overview.cookie, undefined, 'the cookie stays here');
        assert.equal((await consoleApp.inject({ method: 'GET', url: '/api/admin/overview' })).statusCode, 401);
        assert.equal((await consoleApp.inject({
            method: 'POST', url: '/api/admin/staff/login', headers: { 'x-console-request': '1' }, payload: {},
        })).statusCode, 404);
    });

    test('the Simulator only for staff allowed, with its token, and every change logged', async () => {
        const read = await consoleApp.inject({ method: 'GET', url: '/api/simulator/simulation-runs?status=running', headers: cookieOf(VIEWER) });
        assert.equal(read.statusCode, 200, read.body);
        assert.equal(read.json().authorization, `Bearer ${SIM_TOKEN}`);
        assert.equal(read.json().cookie, null);
        assert.deepEqual(read.json().query, { status: 'running' });

        const viewerWrite = await consoleApp.inject({ method: 'POST', url: '/api/simulator/simulation-runs', headers: cookieOf(VIEWER), payload: { user_count: 5 } });
        assert.equal(viewerWrite.statusCode, 403, 'viewing is not running a load test');
        assert.equal((await consoleApp.inject({ method: 'GET', url: '/api/simulator/simulation-runs', headers: cookieOf(NOBODY) })).statusCode, 403);
        assert.equal((await consoleApp.inject({ method: 'GET', url: '/api/simulator/simulation-runs', headers: cookieOf('D'.repeat(43)) })).statusCode, 401);

        const started = await consoleApp.inject({ method: 'POST', url: '/api/simulator/simulation-runs', headers: cookieOf(ROOT), payload: { user_count: 5 } });
        assert.equal(started.statusCode, 202, started.body);
        assert.deepEqual(started.json().run.config, { user_count: 5 });

        const chunk = Buffer.alloc(300_000, 7);
        const upload = await consoleApp.inject({
            method: 'POST', url: `/api/simulator/devices/${encodeURIComponent('AA:BB:CC:00:00:01')}/camera/chunks`,
            headers: { ...cookieOf(ROOT), 'content-type': 'application/octet-stream' }, payload: chunk,
        });
        assert.equal(upload.json().bytes, 300_000, 'binary bodies pass untouched');

        await new Promise(resolve => setTimeout(resolve, 50));
        assert.deepEqual(f.audits.map(item => [item.body.method, item.body.path, item.body.status, item.session]), [
            ['POST', '/simulation-runs', 202, ROOT],
        ], 'refused attempts and camera chunks are not logged');

        const stream = await consoleApp.inject({ method: 'GET', url: '/api/simulator/events/stream', headers: cookieOf(ROOT) });
        assert.match(String(stream.headers['content-type']), /text\/event-stream/);
        assert.match(stream.body, /"type":"hello"/);
    });

    test('signing out ends the session at the Gateway and clears the cookie', async () => {
        const out = await consoleApp.inject({ method: 'POST', url: '/api/session/logout', headers: cookieOf(ROOT) });
        assert.equal(out.statusCode, 200);
        assert.match(String(out.headers['set-cookie']), /sh_console=;/);
        assert.deepEqual(f.logouts, [ROOT]);
    });

    test('serves the web app for page addresses, JSON 404 for unknown API paths', async () => {
        const page = await consoleApp.inject({ method: 'GET', url: '/accounts' });
        assert.equal(page.statusCode, 200);
        assert.match(page.body, /Admin Console/);
        assert.equal(page.headers['x-frame-options'], 'DENY');
        const missing = await consoleApp.inject({ method: 'GET', url: '/api/nothing' });
        assert.equal(missing.statusCode, 404);
        assert.equal(missing.json().error.code, 'NOT_FOUND');
    });

    test('without a Simulator token the Simulator section answers 503', async () => {
        const bare = await buildConsole(loadConfig({ ADMIN_API_KEY: KEY, GATEWAY_URL: url(f.gateway), SIMULATOR_URL: url(f.simulator), STATIC_DIR: staticDir }));
        try {
            const response = await bare.inject({ method: 'GET', url: '/api/simulator/simulation-runs', headers: cookieOf(ROOT) });
            assert.equal(response.statusCode, 503);
            assert.equal(response.json().error.code, 'SIMULATOR_NOT_CONFIGURED');
        } finally {
            await bare.close();
        }
    });

    test('without ADMIN_API_KEY the Console starts and says how to set it up', async () => {
        assert.throws(() => loadConfig({ ADMIN_API_KEY: 'CHANGE_ME' }), /ADMIN_API_KEY/);
        const off = await buildConsole(loadConfig({ GATEWAY_URL: url(f.gateway), STATIC_DIR: staticDir }));
        try {
            const session = await off.inject({ method: 'GET', url: '/api/session', headers: cookieOf(ROOT) });
            assert.equal(session.statusCode, 503);
            assert.equal(session.json().error.code, 'CONSOLE_NOT_CONFIGURED');
            const health = await off.inject({ method: 'GET', url: '/api/health' });
            assert.deepEqual([health.statusCode, health.json().configured], [200, false]);
            assert.equal((await off.inject({ method: 'GET', url: '/' })).statusCode, 200);
        } finally {
            await off.close();
        }
    });
});
