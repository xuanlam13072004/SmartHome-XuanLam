import fs from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import replyFrom from '@fastify/reply-from';
import fastifyStatic from '@fastify/static';
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { ConsoleConfig } from './config';
import {
    callGateway,
    clearSession,
    cookieOptions,
    gatewayHeaders,
    SESSION_COOKIE,
    sessionOf,
    type Staff,
    StaffCache,
} from './gateway';

/**
 * Admin Console backend (docs/architecture/admin.md): the company's single
 * door. Staff sign in here; the browser only ever holds an httpOnly session
 * cookie. Requests are forwarded:
 * - /api/admin/*     → API Gateway /admin/*  (server key + staff session; the
 *                      Gateway checks the permission of every call);
 * - /api/simulator/* → Device Simulator /api/* (Simulator token), only for
 *                      staff with simulator.view (reading) or simulator.manage
 *                      (anything else); changes are written to the admin log.
 * The keys never reach the browser.
 */

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** The virtual camera's webcam stream (twice a second): not worth a log line each. */
const UNLOGGED = /\/camera\/chunks$/;

export const CSRF_HEADER = 'x-console-request';

const failure = (reply: FastifyReply, status: number, code: string, message: string) =>
    reply.status(status).send({ success: false, error: { code, message } });

export async function buildConsole(config: ConsoleConfig): Promise<FastifyInstance> {
    const app = fastify({
        logger: {
            level: process.env.NODE_ENV === 'test' ? 'silent' : 'info',
            redact: ['req.headers.cookie', 'req.headers["x-admin-key"]', 'req.headers["x-staff-session"]', 'req.headers.authorization'],
        },
        bodyLimit: 1024 * 1024,
    });
    await app.register(cookie);
    const staffCache = new StaffCache();

    app.addHook('onSend', async (_request, reply, payload) => {
        reply.header('x-frame-options', 'DENY');
        reply.header('x-content-type-options', 'nosniff');
        reply.header('referrer-policy', 'same-origin');
        return payload;
    });

    // A change must come from the Console's own pages: another site cannot add
    // this header to a request (and the cookie is SameSite=Strict anyway).
    app.addHook('onRequest', async (request, reply) => {
        if (!request.url.startsWith('/api/') || READS.has(request.method)) return;
        if (request.headers[CSRF_HEADER] !== '1') {
            return failure(reply, 403, 'CONSOLE_REQUEST_REQUIRED', 'Yêu cầu không đến từ trang Admin Console.');
        }
    });

    // Without the server key there is no administration (the Gateway's /admin
    // does not exist either): every page says how to set it up.
    if (!config.ADMIN_API_KEY) {
        app.addHook('onRequest', async (request, reply) => {
            if (!request.url.startsWith('/api/') || request.url === '/api/health') return;
            return failure(reply, 503, 'CONSOLE_NOT_CONFIGURED',
                'Admin Console chưa được bật: đặt ADMIN_API_KEY trong file .env gốc (docs/architecture/admin.md).');
        });
    }

    app.get('/api/health', async () => ({ status: 'ok', service: 'admin-console', configured: Boolean(config.ADMIN_API_KEY) }));

    // ── Session ────────────────────────────────────────────────────────────

    app.post('/api/session/login', async (request, reply) => {
        const body = (request.body ?? {}) as { email?: unknown; password?: unknown };
        const result = await callGateway(config, request, null, '/admin/staff/login', {
            method: 'POST',
            body: { email: String(body.email ?? ''), password: String(body.password ?? '') },
        });
        if (result.status !== 200) return reply.status(result.status).send(result.body);
        const expires = Math.max(60, Math.floor((Date.parse(result.body.expires_at) - Date.now()) / 1000));
        reply.setCookie(SESSION_COOKIE, result.body.session_token, cookieOptions(config, expires));
        return { success: true, staff: result.body.staff, expires_at: result.body.expires_at, idle_minutes: result.body.idle_minutes };
    });

    app.post('/api/session/logout', async (request, reply) => {
        const session = sessionOf(request);
        if (session) {
            await callGateway(config, request, session, '/admin/staff/logout', { method: 'POST' });
            staffCache.forget(session);
        }
        clearSession(config, reply);
        return { success: true };
    });

    app.get('/api/session', async (request, reply) => {
        const session = sessionOf(request);
        const result = session
            ? await callGateway(config, request, session, '/admin/staff/me')
            : { status: 401, body: { success: false, error: { code: 'STAFF_SESSION_INVALID', message: 'Chưa đăng nhập.' } } };
        if (result.status === 401) clearSession(config, reply);
        return reply.status(result.status).send({
            ...result.body,
            ...(result.status === 200 ? { simulator: Boolean(config.SIMULATOR_TOKEN) } : {}),
        });
    });

    // ── API Gateway /admin ─────────────────────────────────────────────────

    await app.register(async (gateway) => {
        await gateway.register(replyFrom, { base: config.GATEWAY_URL });
        gateway.all('/api/admin/*', async (request, reply) => {
            // Signing in only through /api/session/login, which sets the cookie.
            if (request.url.startsWith('/api/admin/staff/login')) return failure(reply, 404, 'NOT_FOUND', 'Not found');
            const session = sessionOf(request);
            if (!session) return failure(reply, 401, 'STAFF_SESSION_INVALID', 'Phiên đăng nhập đã hết. Vui lòng đăng nhập lại.');
            return reply.from(request.url.replace(/^\/api\/admin/, '/admin'), {
                rewriteRequestHeaders: (_original, headers) => {
                    const { cookie: _cookie, [CSRF_HEADER]: _csrf, authorization: _authorization, ...rest } = headers;
                    return { ...rest, ...gatewayHeaders(config, request, session) };
                },
                onResponse: (_request, _reply, res) => {
                    if (res.statusCode === 401) {
                        staffCache.forget(session);
                        clearSession(config, reply);
                    }
                    reply.send(res.stream);
                },
            });
        });
    });

    // ── Device Simulator ───────────────────────────────────────────────────

    const staffOf = (request: FastifyRequest, session: string): Promise<Staff | null> =>
        staffCache.get(session, async () => {
            const result = await callGateway(config, request, session, '/admin/staff/me');
            return result.status === 200 ? result.body.staff as Staff : null;
        });

    const can = (staff: Staff, permission: string) => staff.is_root || staff.permissions.includes(permission);

    await app.register(async (simulator) => {
        // Bodies (JSON or the camera's binary chunks) are streamed through untouched.
        simulator.removeAllContentTypeParsers();
        simulator.addContentTypeParser('*', (_request, payload, done) => done(null, payload));
        await simulator.register(replyFrom, {
            base: config.SIMULATOR_URL,
            undici: { headersTimeout: config.SIMULATOR_TIMEOUT_MS, bodyTimeout: 0 },
        });

        simulator.all('/api/simulator/*', {
            bodyLimit: 16 * 1024 * 1024,
            preHandler: async (request, reply) => {
                if (!config.SIMULATOR_TOKEN) {
                    return failure(reply, 503, 'SIMULATOR_NOT_CONFIGURED', 'Admin Console chưa được nối với Simulator (SIMULATOR_TOKEN).');
                }
                const session = sessionOf(request);
                const staff = session ? await staffOf(request, session) : null;
                if (!staff) {
                    clearSession(config, reply);
                    return failure(reply, 401, 'STAFF_SESSION_INVALID', 'Phiên đăng nhập đã hết. Vui lòng đăng nhập lại.');
                }
                if (staff.must_change_password) {
                    return failure(reply, 403, 'STAFF_PASSWORD_CHANGE_REQUIRED', 'Hãy đổi mật khẩu tạm trước khi tiếp tục.');
                }
                const needed = READS.has(request.method) ? 'simulator.view' : 'simulator.manage';
                if (!can(staff, needed)) return failure(reply, 403, 'STAFF_FORBIDDEN', 'Bạn không có quyền làm việc này trong Simulator.');
            },
            // After the Simulator answered: each change goes to the admin log, under the person's name.
            onResponse: async (request, reply) => {
                if (READS.has(request.method) || reply.statusCode >= 500 || reply.statusCode === 401 || reply.statusCode === 403) return;
                const pathname = request.url.split('?')[0].replace(/^\/api\/simulator/, '');
                if (UNLOGGED.test(pathname)) return;
                let readable = pathname;
                try { readable = decodeURIComponent(pathname); } catch { /* keep it encoded */ }
                const session = sessionOf(request);
                const logged = await callGateway(config, request, session, '/admin/audit/simulator', {
                    method: 'POST', body: { method: request.method, path: readable.slice(0, 200), status: reply.statusCode },
                });
                if (logged.status !== 200) request.log.warn({ status: logged.status, path: readable }, 'Simulator change not logged');
            },
        }, async (request, reply) => reply.from(request.url.replace(/^\/api\/simulator/, '/api'), {
            // The parsed "body" is the request stream itself: piped to the Simulator as it comes.
            rewriteRequestHeaders: (_original, headers) => {
                const { cookie: _cookie, [CSRF_HEADER]: _csrf, ...rest } = headers;
                return { ...rest, authorization: `Bearer ${config.SIMULATOR_TOKEN}` };
            },
        }));
    });

    // ── The web app ────────────────────────────────────────────────────────

    const index = path.join(config.STATIC_DIR, 'index.html');
    if (fs.existsSync(index)) {
        await app.register(fastifyStatic, { root: config.STATIC_DIR, wildcard: false, index: false });
        app.get('/', (_request, reply) => reply.sendFile('index.html'));
    }
    app.setNotFoundHandler((request, reply) => {
        if (request.method === 'GET' && !request.url.startsWith('/api/') && fs.existsSync(index)) {
            return reply.type('text/html').sendFile('index.html');
        }
        return failure(reply, 404, 'NOT_FOUND', 'Not found');
    });

    return app;
}
