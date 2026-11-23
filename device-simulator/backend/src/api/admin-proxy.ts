/**
 * The "Quản trị" page talks to the API Gateway's /admin API through this
 * backend (docs/architecture/admin.md): the browser proves it is the operator
 * with the Simulator's ADMIN_TOKEN (checked for every /api request), and this
 * server adds the Gateway's ADMIN_API_KEY, which never leaves it. Calls go to
 * the Gateway inside the Docker network, never through Cloudflare Tunnel.
 */

export interface AdminProxyRequest {
    method: string;
    /** Gateway path, e.g. /admin/accounts/<id>/disable. */
    path: string;
    /** '' or '?…' as received. */
    search: string;
    body?: unknown;
}

export interface AdminProxyConfig {
    baseUrl: string;
    key: string | undefined;
    timeoutMs: number;
}

export interface AdminProxyResponse {
    status: number;
    body: unknown;
}

/** Only the Gateway's administration routes, nothing else on the Gateway. */
const ADMIN_PATH = /^\/admin(\/[A-Za-z0-9_-]+){1,3}$/;

const failure = (status: number, code: string, message: string): AdminProxyResponse => ({
    status,
    body: { success: false, error: { code, message } },
});

export async function forwardAdmin(
    request: AdminProxyRequest,
    config: AdminProxyConfig,
    fetchImpl: typeof fetch = fetch,
): Promise<AdminProxyResponse> {
    if (!config.key) {
        return failure(503, 'ADMIN_NOT_CONFIGURED',
            'Chưa cấu hình quản trị: đặt cùng một ADMIN_API_KEY cho API Gateway và Simulator rồi khởi động lại.');
    }
    if (!ADMIN_PATH.test(request.path) || (request.method !== 'GET' && request.method !== 'POST')) {
        return failure(404, 'NOT_FOUND', 'Không có trang quản trị này.');
    }
    const hasBody = request.method === 'POST';
    try {
        const response = await fetchImpl(`${config.baseUrl.replace(/\/$/, '')}${request.path}${request.search}`, {
            method: request.method,
            headers: {
                'x-admin-key': config.key,
                ...(hasBody ? { 'content-type': 'application/json' } : {}),
            },
            body: hasBody ? JSON.stringify(request.body ?? {}) : undefined,
            signal: AbortSignal.timeout(config.timeoutMs),
        });
        const body = await response.json().catch(() => null);
        return body === null
            ? failure(502, 'ADMIN_BAD_RESPONSE', `API Gateway trả về HTTP ${response.status} không đọc được.`)
            : { status: response.status, body };
    } catch {
        return failure(502, 'ADMIN_GATEWAY_UNREACHABLE', 'Không kết nối được API Gateway.');
    }
}
