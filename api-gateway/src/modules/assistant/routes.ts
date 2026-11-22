import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { typedRouteConfig } from '../../plugins/validation';
import { httpError } from '../../utils/httpError';
import { hasRecentReauthentication } from '../auth/reauth';
import { voiceRequest } from '../voice/client';
import { AUDIO_UPLOAD_LIMITS, readUpload } from '../voice/upload';
import { saveDraft } from './draftStore';
import { clearHistory } from './memory';
import { listPlans, usageSummary } from './quota';
import { confirmPending, runAssistantTurn, type VoiceInput } from './service';

const accountIdOf = (request: FastifyRequest) => (request.user as { userId: string }).userId;
const turns = { max: 20, timeWindow: '1 minute' };

const messageSchema = z.object({ body: z.object({ text: z.string().trim().min(1).max(500) }) });
const confirmSchema = z.object({ body: z.object({ pending_id: z.string().min(8).max(32) }) });
const saveDraftSchema = z.object({
    params: z.object({ draftId: z.string().regex(/^[A-Za-z0-9_-]{8,32}$/) }),
    // An IANA name such as Asia/Ho_Chi_Minh; PostgreSQL checks that it exists.
    body: z.object({ timezone: z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_+\-/]*$/) }).strict(),
});

interface Heard {
    transcript: string;
    verification: { accepted: boolean; reason: string | null } | null;
}

/**
 * The assistant ("Trợ lý", docs/architecture/assistant.md). Typed messages
 * act like taps in the app; spoken commands that change something must come
 * from the account owner's verified voice.
 */
const assistantRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
    await app.register(multipart, { limits: AUDIO_UPLOAD_LIMITS });

    app.post('/assistant/message', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({ zodSchema: messageSchema, rateLimit: turns }),
    }, async (request) => ({
        success: true,
        ...(await runAssistantTurn(app, accountIdOf(request), {
            channel: 'text', message: (request.body as { text: string }).text,
        })),
    }));

    // audio: one 16 kHz mono WAV recording of the command.
    app.post('/assistant/voice', {
        preHandler: [app.authenticate],
        config: { rateLimit: turns },
    }, async (request) => {
        const accountId = accountIdOf(request);
        const { files } = await readUpload(request, { audio: 1 });
        const heard = await voiceRequest<Heard>('POST', `/v1/listen/${accountId}`, { files, timeoutMs: 60_000 });
        if (!heard) throw httpError(503, 'VOICE_UNAVAILABLE', 'Dịch vụ giọng nói đang tạm dừng, hãy thử lại sau.');
        const voice: VoiceInput = { transcript: heard.transcript, verification: heard.verification };
        return {
            success: true,
            transcript: heard.transcript,
            voice_verified: heard.verification ? heard.verification.accepted : null,
            ...(await runAssistantTurn(app, accountId, { channel: 'voice', message: heard.transcript, voice })),
        };
    });

    // A command that needs confirmation (X-Reauth-Token when it needs the password).
    app.post('/assistant/confirm', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({ zodSchema: confirmSchema, rateLimit: turns }),
    }, async (request) => ({
        success: true,
        ...(await confirmPending(app, accountIdOf(request), (request.body as { pending_id: string }).pending_id,
            hasRecentReauthentication(app, request))),
    }));

    // A scene or automation the assistant drafted, saved when the user taps "Lưu".
    app.post('/assistant/drafts/:draftId/save', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({ zodSchema: saveDraftSchema, rateLimit: turns }),
    }, async (request) => ({
        success: true,
        ...(await saveDraft(app, accountIdOf(request), (request.params as { draftId: string }).draftId,
            (request.body as { timezone: string }).timezone)),
    }));

    app.delete('/assistant/conversation', {
        preHandler: [app.authenticate],
    }, async (request) => {
        await clearHistory(app, accountIdOf(request));
        return { success: true };
    });

    app.get('/assistant/usage', {
        preHandler: [app.authenticate],
    }, async (request) => ({
        success: true,
        ...(await usageSummary(app, accountIdOf(request))),
        plans: await listPlans(app),
    }));
};

export default assistantRoutes;
