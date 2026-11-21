import type { FastifyInstance } from 'fastify';
import { verifyPassword } from '../account/security';
import { httpError } from '../../utils/httpError';
import { AudioPart, voiceRequest } from './client';
import { assertVoiceUnlocked, clearVoiceFailures, recordVoiceFailure, voiceLockState } from './lockout';

/**
 * Voice profile ("Giọng nói" in Cá nhân): 1:1 verification that a recording is
 * the signed-in account owner's voice. voice-service does the audio work;
 * the Gateway owns who may do what, rate limits and the temporary lock.
 */

const profilePath = (accountId: string) => `/v1/profiles/${accountId}`;

export interface VoiceVerification {
    accepted: boolean;
    reason: 'not_matched' | 'spoof_suspected' | 'low_confidence' | null;
    scores: Record<string, number | null>;
    thresholds: Record<string, unknown>;
    gallery_updated: boolean;
}

export async function getVoiceProfile(app: FastifyInstance, accountId: string) {
    let profile: unknown = null;
    try {
        profile = await voiceRequest('GET', profilePath(accountId));
    } catch (error: any) {
        if (error?.code !== 'VOICE_PROFILE_NOT_FOUND') throw error;
    }
    return { profile, lock: await voiceLockState(app, accountId) };
}

export async function enrollVoice(app: FastifyInstance, accountId: string, files: AudioPart[], consent: boolean) {
    if (!consent) {
        throw httpError(400, 'VOICE_CONSENT_REQUIRED', 'Cần đồng ý cho lưu đặc trưng giọng nói trước khi đăng ký.');
    }
    // Enrollment trains the profile's anti-spoof model: allow it time.
    return voiceRequest('PUT', profilePath(accountId), { files, fields: { consent: 'true' }, timeoutMs: 120_000 });
}

/** Deleting the voiceprint needs the password: whoever holds an unlocked phone must not swap in their own voice. */
export async function deleteVoiceProfile(app: FastifyInstance, accountId: string, password: string) {
    await verifyPassword(app, accountId, password);
    await voiceRequest('DELETE', profilePath(accountId));
    await clearVoiceFailures(app, accountId, true);
}

/** Verifies a recording; rejections count towards the temporary lock. Reused by voice commands. */
export async function verifyVoice(app: FastifyInstance, accountId: string, audio: AudioPart) {
    await assertVoiceUnlocked(app, accountId);
    const result = await voiceRequest<VoiceVerification>('POST', `${profilePath(accountId)}/verify`, { files: [audio] });
    if (!result) throw httpError(503, 'VOICE_UNAVAILABLE', 'Dịch vụ giọng nói đang tạm dừng, hãy thử lại sau.');
    if (result.accepted) {
        await clearVoiceFailures(app, accountId);
        return { result, lock: await voiceLockState(app, accountId) };
    }
    return { result, lock: await recordVoiceFailure(app, accountId) };
}

/** Calibration, extra samples and recorded replays change the profile: refused while locked. */
export async function updateVoiceProfile(
    app: FastifyInstance,
    accountId: string,
    action: 'calibrate' | 'samples' | 'antispoof',
    files: AudioPart[],
) {
    await assertVoiceUnlocked(app, accountId);
    return voiceRequest('POST', `${profilePath(accountId)}/${action}`, { files, timeoutMs: 60_000 });
}
