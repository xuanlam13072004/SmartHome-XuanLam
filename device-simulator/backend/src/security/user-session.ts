import type { SimulatedUserRecord } from '../domain/registry';
import { getGatewayPacer } from '../generation/pacer';
import { apiGateway } from '../infrastructure/api-gateway/client';
import type { RequestOptions } from '../infrastructure/api-gateway/rate-limit-retry';
import { getMongoDb } from '../infrastructure/mongodb/client';
import { decryptAccessToken, decryptRefreshToken, encryptAuthSession, type LoginSession } from './auth-session';
import { decrypt } from './crypto';

/**
 * Acting as a simulated user, exactly like their app would: the stored
 * session's access token while it has a couple of minutes left, else the
 * session refreshed, else a new sign-in with the stored password. Everything
 * the Simulator reads or changes in the system goes through these tokens.
 * Sign-ins share the Simulator's login pace (the API limits them per IP).
 */

/** Seconds before the JWT expires (0 when it cannot be read). */
export function tokenSecondsLeft(token: string, now = Date.now()): number {
    try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
        return typeof payload.exp === 'number' ? payload.exp - Math.floor(now / 1000) : 0;
    } catch {
        return 0;
    }
}

export const userPassword = (user: Pick<SimulatedUserRecord, 'credential'>): string =>
    decrypt(user.credential.iv, user.credential.encrypted, user.credential.authTag);

/** Signs in with the stored password (paced); the session is stored on the record. */
export async function signInUser(user: SimulatedUserRecord, options: RequestOptions = {}): Promise<LoginSession> {
    await getGatewayPacer().login.take(options.signal);
    const session = await apiGateway.login({ email: user.email, password: userPassword(user) }, options);
    await storeSession(user, session);
    return session;
}

/** A valid access token for [user]; a new session is stored back in the registry. */
export async function userAccessToken(
    user: SimulatedUserRecord,
    options: RequestOptions = {},
    { forceNew = false }: { forceNew?: boolean } = {},
): Promise<string> {
    if (user.auth_session && !forceNew) {
        const token = decryptAccessToken(user.auth_session);
        if (tokenSecondsLeft(token) > 120) return token;
    }
    if (user.auth_session) {
        try {
            const session = await apiGateway.refreshSession({
                sessionId: user.auth_session.session_id,
                refreshToken: decryptRefreshToken(user.auth_session),
            }, options);
            await storeSession(user, session);
            return session.accessToken;
        } catch {
            // Expired or revoked: sign in again below.
        }
    }
    return (await signInUser(user, options)).accessToken;
}

/** The same, from the account id (null when the Simulator does not know the account). */
export async function accessTokenFor(accountId: string, options: RequestOptions = {}): Promise<string | null> {
    const user = await getMongoDb().collection<SimulatedUserRecord>('simulated_users').findOne({ account_id: accountId });
    return user ? userAccessToken(user, options) : null;
}

async function storeSession(user: SimulatedUserRecord, session: LoginSession): Promise<void> {
    user.auth_session = encryptAuthSession(session);
    await getMongoDb().collection<SimulatedUserRecord>('simulated_users').updateOne(
        { run_id: user.run_id, generation_index: user.generation_index },
        { $set: { auth_session: user.auth_session, updated_at: new Date() } },
    );
}
