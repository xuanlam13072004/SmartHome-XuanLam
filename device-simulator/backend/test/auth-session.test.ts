import assert from 'node:assert/strict';
import test from 'node:test';
import {
    decryptAccessToken,
    decryptRefreshToken,
    encryptAuthSession,
} from '../src/security/auth-session';

test('stored login sessions encrypt both tokens and retain only session metadata in plaintext', () => {
    const encrypted = encryptAuthSession({
        accessToken: 'access-token-value',
        refreshToken: 'refresh-token-value',
        sessionId: 'session-id',
    }, new Date('2026-07-27T00:00:00.000Z'));

    assert.equal(encrypted.session_id, 'session-id');
    assert.notEqual(encrypted.access_token.encrypted, 'access-token-value');
    assert.notEqual(encrypted.refresh_token.encrypted, 'refresh-token-value');
    assert.equal(decryptAccessToken(encrypted), 'access-token-value');
    assert.equal(decryptRefreshToken(encrypted), 'refresh-token-value');
});
