import { env } from '../../config/env';
import { fetchWithRateLimitRetry, type RequestOptions } from './rate-limit-retry';
import type {
    TopologyRole,
    TopologyState,
} from '../../domain/registry';

export interface ClaimedDevice {
    id: string;
    mac: string;
    owner_id: string;
    product_id: string;
    catalog_revision: number | string;
    network_id?: string | null;
    join_rank?: number | string | null;
    topology_role?: TopologyRole;
    topology_epoch?: number | string | null;
    topology_state?: TopologyState;
    active_hub_device_id?: string | null;
    active_hub_mac?: string | null;
}

/** One device as the factory API receives it (hashes only; docs/architecture/mqtt-security.md). */
export interface FactoryDeviceBody {
    mac: string;
    product_id: string;
    catalog_revision: number;
    firmware_family: string;
    hardware_revision: string;
    secret_key_hash: string;
    credential_public_key_pem: string;
    mqtt_password_hash: string;
    mqtt_salt: string;
}

export type FactoryCreateStatus = 'created' | 'exists' | 'conflict' | 'product_unknown';
export type FactoryRetireStatus = 'retired' | 'missing' | 'claimed';

/** A device as its user's app sees it (GET /devices): the claim fields plus the user's role. */
export interface AccountDevice extends ClaimedDevice {
    role: string;
}

/** An API Gateway refusal: HTTP status and the API's error code (EMAIL_TAKEN, ACCOUNT_OWNS_DEVICES…). */
export type ApiGatewayError = Error & { statusCode?: number; code?: string };

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
        options: RequestOptions = {},
    ): Promise<T> {
        const response = await fetchWithRateLimitRetry(`${this.baseUrl}${path}`, init, {
            ...options, timeoutMs: env.API_REQUEST_TIMEOUT_MS,
        });
        const body = await response.json().catch(() => null) as T | ApiErrorEnvelope | null;
        if (!response.ok) {
            const error = new Error(getErrorMessage(body, `API Gateway returned HTTP ${response.status}`)) as ApiGatewayError;
            error.statusCode = response.status;
            const envelope = body as ApiErrorEnvelope | null;
            if (envelope && typeof envelope.error === 'object' && typeof envelope.error?.code === 'string') {
                error.code = envelope.error.code;
            }
            throw error;
        }
        return body as T;
    }

    private bearer(accessToken: string, json = false): Record<string, string> {
        return { Authorization: `Bearer ${accessToken}`, ...(json ? { 'Content-Type': 'application/json' } : {}) };
    }

    private factory<T>(path: string, body: unknown, options: RequestOptions = {}): Promise<T> {
        return this.request<T>(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Factory-Key': env.FACTORY_API_KEY },
            body: JSON.stringify(body),
        }, options);
    }

    // ── Factory API (the Simulator as a factory) ─────────────────────────────

    async createFactoryDevices(devices: FactoryDeviceBody[], options: RequestOptions = {}) {
        const data = await this.factory<{ devices: Array<{ mac: string; status: FactoryCreateStatus }> }>(
            '/factory/devices', { devices }, options);
        return data.devices;
    }

    async factoryDeviceStatus(macs: string[], options: RequestOptions = {}) {
        const data = await this.factory<{ devices: Array<{ mac: string; exists: boolean; claimed: boolean }> }>(
            '/factory/devices/status', { macs }, options);
        return data.devices;
    }

    async retireFactoryDevices(macs: string[], options: RequestOptions = {}) {
        const data = await this.factory<{ devices: Array<{ mac: string; status: FactoryRetireStatus }> }>(
            '/factory/devices/retire', { macs }, options);
        return data.devices;
    }

    // ── As a simulated user (the app's own calls) ────────────────────────────

    /** Deletes the signed-in account (the app's "Xóa tài khoản"); it must own no device. */
    async deleteAccount(accessToken: string, password: string, options: RequestOptions = {}): Promise<void> {
        await this.request('/me', {
            method: 'DELETE', headers: this.bearer(accessToken, true), body: JSON.stringify({ password }),
        }, options);
    }

    async listDevices(accessToken: string, options: RequestOptions = {}): Promise<AccountDevice[]> {
        const data = await this.request<{ devices: AccountDevice[] }>('/devices', { headers: this.bearer(accessToken) }, options);
        return data.devices ?? [];
    }

    /** The device's state as the backend keeps it (shadow), as its user sees it. */
    async deviceState(accessToken: string, mac: string, options: RequestOptions = {}): Promise<unknown> {
        const data = await this.request<{ state: unknown }>(`/devices/${encodeURIComponent(mac)}/state`,
            { headers: this.bearer(accessToken) }, options);
        return data.state ?? null;
    }

    /** The device's events as the backend recorded them, newest first. */
    async deviceEvents(accessToken: string, mac: string, limit: number, options: RequestOptions = {}): Promise<unknown[]> {
        const data = await this.request<{ events?: unknown[] }>(
            `/devices/${encodeURIComponent(mac)}/events?limit=${Math.min(Math.max(limit, 1), 100)}`,
            { headers: this.bearer(accessToken) }, options);
        return data.events ?? [];
    }

    /** One command's status and timestamps (created_at, completed_at). */
    async deviceOperation(accessToken: string, mac: string, operationId: string, options: RequestOptions = {}) {
        const data = await this.request<{ operation: { id: string; status: string; created_at: string; completed_at: string | null } }>(
            `/devices/${encodeURIComponent(mac)}/operations/${encodeURIComponent(operationId)}`,
            { headers: this.bearer(accessToken) }, options);
        return data.operation;
    }

    async health(): Promise<void> {
        await this.request('/auth/health');
    }

    async register(user: {
        email: string;
        password: string;
        full_name: string;
    }, options: RequestOptions = {}): Promise<{ id: string; email: string; full_name: string }> {
        const data = await this.request<{
            success: boolean;
            user: { id: string; email: string; full_name: string };
        }>('/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(user),
        }, options);
        if (!data.success || !data.user) {
            throw new Error('API Gateway returned an invalid register response');
        }
        return data.user;
    }

    async login(credentials: {
        email: string;
        password: string;
    }, options: RequestOptions = {}): Promise<{ accessToken: string; refreshToken: string; sessionId: string }> {
        const data = await this.request<{
            success: boolean;
            access_token: string;
            refresh_token: string;
            session_id: string;
        }>('/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(credentials),
        }, options);
        if (!data.success || !data.access_token || !data.refresh_token || !data.session_id) {
            throw new Error('API Gateway returned an invalid login response');
        }
        return {
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            sessionId: data.session_id,
        };
    }

    async getCurrentUser(accessToken: string, options: RequestOptions = {}): Promise<{ id: string; email: string }> {
        const data = await this.request<{
            success: boolean;
            user: { id: string; email: string };
        }>('/auth/me', {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
            },
        }, options);
        if (!data.success || !data.user?.id || !data.user?.email) {
            throw new Error('API Gateway returned an invalid current-user response');
        }
        return data.user;
    }

    async refreshSession(input: {
        sessionId: string;
        refreshToken: string;
    }, options: RequestOptions = {}): Promise<{ accessToken: string; refreshToken: string; sessionId: string }> {
        const data = await this.request<{
            success: boolean;
            access_token: string;
            refresh_token: string;
            session_id: string;
        }>('/auth/refresh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                session_id: input.sessionId,
                refresh_token: input.refreshToken,
            }),
        }, options);
        if (!data.success || !data.access_token || !data.refresh_token || !data.session_id) {
            throw new Error('API Gateway returned an invalid refresh response');
        }
        return {
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            sessionId: data.session_id,
        };
    }

    async claimDevice(
        accessToken: string,
        claimData: {
            mac: string;
            secret_key: string;
            name?: string;
            network_fingerprint?: string;
        },
        options: RequestOptions = {},
    ): Promise<ClaimedDevice> {
        const data = await this.request<{
            success: boolean;
            device: ClaimedDevice;
        }>('/devices/claim', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`,
            },
            body: JSON.stringify(claimData),
        }, options);
        if (!data.success || !data.device) {
            throw new Error('API Gateway returned an invalid claim response');
        }
        return data.device;
    }

    async unpairDevice(accessToken: string, mac: string, options: RequestOptions = {}): Promise<void> {
        const data = await this.request<{ success: boolean }>(
            `/devices/${encodeURIComponent(mac)}`,
            {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                },
            },
            options,
        );
        if (!data.success) {
            throw new Error('API Gateway returned an invalid unpair response');
        }
    }
}

export const apiGateway = new ApiGatewayClient();
