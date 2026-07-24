import { env } from '../../config/env';

export class ApiGatewayClient {
    private baseUrl: string;

    constructor() {
        this.baseUrl = env.API_GATEWAY_URL;
    }

    async register(user: any): Promise<any> {
        const response = await fetch(`${this.baseUrl}/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(user)
        });
        
        const data = await response.json();
        if (!response.ok || !data.success) {
            throw new Error(data.error || 'Failed to register user');
        }
        return data.user;
    }

    async login(credentials: any): Promise<{ accessToken: string; refreshToken: string; sessionId: string }> {
        const response = await fetch(`${this.baseUrl}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(credentials)
        });
        
        const data = await response.json();
        if (!response.ok || !data.success) {
            throw new Error(data.error || 'Failed to login user');
        }
        return {
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            sessionId: data.session_id,
        };
    }

    async claimDevice(accessToken: string, claimData: { mac: string; secret_key: string; name?: string }): Promise<any> {
        const response = await fetch(`${this.baseUrl}/devices/claim`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`
            },
            body: JSON.stringify(claimData)
        });
        
        const data = await response.json();
        if (!response.ok || !data.success) {
            throw new Error(data.error || 'Failed to claim device');
        }
        return data.device;
    }
}

export const apiGateway = new ApiGatewayClient();
