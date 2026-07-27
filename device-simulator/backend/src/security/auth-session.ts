import type { EncryptedValue } from '../domain/registry';
import { decrypt, encrypt } from './crypto';

export interface LoginSession {
    accessToken: string;
    refreshToken: string;
    sessionId: string;
}

export interface EncryptedAuthSession {
    session_id: string;
    access_token: EncryptedValue;
    refresh_token: EncryptedValue;
    updated_at: Date;
}

export const encryptAuthSession = (
    session: LoginSession,
    updatedAt: Date = new Date(),
): EncryptedAuthSession => ({
    session_id: session.sessionId,
    access_token: encrypt(session.accessToken),
    refresh_token: encrypt(session.refreshToken),
    updated_at: updatedAt,
});

export const decryptRefreshToken = (session: EncryptedAuthSession): string =>
    decrypt(
        session.refresh_token.iv,
        session.refresh_token.encrypted,
        session.refresh_token.authTag,
    );
