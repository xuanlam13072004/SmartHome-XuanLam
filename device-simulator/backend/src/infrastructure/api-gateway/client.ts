import { env } from '../../config/env';

interface ApiErrorEnvelope {
    error?: string | {
        code?: string;
        message?: string;
    };
    message?: string;
}

const getErrorMessage = (body: unknown, fallback: string): string => {
    if (!body || typeof body !== 'object') return fallback;
    const envelope = body as ApiErrorEnvelope;
    if (typeof envelope.error === 'string') return envelope.error;
    if (envelope.error && typeof envelope.error.message === 'string') return envelope.error.message;
    if (typeof envelope.message === 'string') return envelope.message;
    return fallback;
};

export class ApiGatewayClient {
    private readonly baseUrl: string;

    constructor() {
        this.baseUrl = env.API_GATEWAY_URL.replace(/\/$/, '');
    }

    private async request<T>(
        path: string,
        init: RequestInit = {},
    ): Promise<T> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), env.API_REQUEST_TIMEOUT_MS);
        try {
            const response = await fetch(`${this.baseUrl}${path}`, {
                ...init,
                signal: controller.signal,
            });
            const body = await response.json().catch(() => null) as T | ApiErrorEnvelope | null;
            if (!response.ok) {
                const error = new Error(getErrorMessage(body, `API Gateway returned HTTP ${response.status}`)) as Error & {
                    statusCode?: number;
                };
                error.statusCode = response.status;
                throw error;
            }
            return body as T;
        } finally {
            clearTimeout(timer);
        }
    }

    async health(): Promise<void> {
        await this.request('/auth/health');
    }

    async register(user: {
        username: string;
        email: string;
        password: string;
        full_name: string;
    }): Promise<{ id: string; username: string; email: string; full_name: string }> {
        const data = await this.request<{
            success: boolean;
            user: { id: string; username: string; email: string; full_name: string };
        }>('/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(user),
        });
        if (!data.success || !data.user) {
            throw new Error('API Gateway returned an invalid register response');
        }
        return data.user;
    }

    async login(credentials: {
        email: string;
        password: string;
    }): Promise<{ accessToken: string; refreshToken: string; sessionId: string }> {
        const data = await this.request<{
            success: boolean;
            access_token: string;
            refresh_token: string;
            session_id: string;
        }>('/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(credentials),
        });
        if (!data.success || !data.access_token || !data.refresh_token || !data.session_id) {
            throw new Error('API Gateway returned an invalid login response');
        }
        return {
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            sessionId: data.session_id,
        };
    }

    async getCurrentUser(accessToken: string): Promise<{ id: string; email: string }> {
        const data = await this.request<{
            success: boolean;
            user: { id: string; email: string };
        }>('/auth/me', {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
            },
        });
        if (!data.success || !data.user?.id || !data.user?.email) {
            throw new Error('API Gateway returned an invalid current-user response');
        }
        return data.user;
    }

    async claimDevice(
        accessToken: string,
        claimData: { mac: string; secret_key: string; name?: string },
    ): Promise<{ id: string; mac: string; owner_id: string; product_id: string }> {
        const data = await this.request<{
            success: boolean;
            device: { id: string; mac: string; owner_id: string; product_id: string };
        }>('/devices/claim', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`,
            },
            body: JSON.stringify(claimData),
        });
        if (!data.success || !data.device) {
            throw new Error('API Gateway returned an invalid claim response');
        }
        return data.device;
    }
}

export const apiGateway = new ApiGatewayClient();
