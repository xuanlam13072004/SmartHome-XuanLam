import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ConsoleConfig } from './config';

/**
 * The signed-in browser holds a session token in an httpOnly cookie; this
 * server sends it to the API Gateway with the server key. The Gateway checks
 * both, and the staff member's permission, on every /admin call.
 */
export const SESSION_COOKIE = 'sh_console';
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export interface Staff {
    id: string;
    email: string;
    full_name: string;
    is_root: boolean;
    permissions: string[];
    must_change_password: boolean;
}

export function sessionOf(request: FastifyRequest): string | null {
    const value = request.cookies?.[SESSION_COOKIE];
    return value && TOKEN.test(value) ? value : null;
}

export function cookieOptions(config: ConsoleConfig, maxAgeSeconds?: number) {
    return {
        path: '/',
        httpOnly: true,
        sameSite: 'strict' as const,
        secure: config.COOKIE_SECURE,
        ...(maxAgeSeconds !== undefined ? { maxAge: maxAgeSeconds } : {}),
    };
}

export function clearSession(config: ConsoleConfig, reply: FastifyReply) {
    reply.clearCookie(SESSION_COOKIE, cookieOptions(config));
}

/** Headers proving this server (key) and the person (session), plus who is at the browser. */
export function gatewayHeaders(config: ConsoleConfig, request: FastifyRequest, session: string | null): Record<string, string> {
    return {
        'x-admin-key': config.ADMIN_API_KEY,
        ...(session ? { 'x-staff-session': session } : {}),
        'x-staff-client-ip': request.ip,
        'x-staff-client': String(request.headers['user-agent'] ?? '').slice(0, 200),
    };
}

export async function callGateway(
    config: ConsoleConfig,
    request: FastifyRequest,
    session: string | null,
    path: string,
    init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
    try {
        const response = await fetch(`${config.GATEWAY_URL.replace(/\/$/, '')}${path}`, {
            method: init.method ?? 'GET',
            headers: {
                ...gatewayHeaders(config, request, session),
                ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
            },
            body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
            signal: AbortSignal.timeout(15_000),
        });
        return { status: response.status, body: await response.json().catch(() => null) };
    } catch {
        return {
            status: 502,
            body: { success: false, error: { code: 'GATEWAY_UNREACHABLE', message: 'Không kết nối được API Gateway.' } },
        };
    }
}

/**
 * Who is signed in, cached a few seconds per session so a Simulator page
 * polling every second does not ask the Gateway every time. A permission the
 * root removes applies within that delay.
 */
export class StaffCache {
    private readonly entries = new Map<string, { staff: Staff | null; at: number }>();

    constructor(private readonly ttlMs = 10_000, private readonly max = 1000) {}

    async get(session: string, load: () => Promise<Staff | null>): Promise<Staff | null> {
        const hit = this.entries.get(session);
        if (hit && Date.now() - hit.at < this.ttlMs) return hit.staff;
        const staff = await load();
        if (this.entries.size >= this.max) this.entries.clear();
        this.entries.set(session, { staff, at: Date.now() });
        return staff;
    }

    forget(session: string) {
        this.entries.delete(session);
    }
}
