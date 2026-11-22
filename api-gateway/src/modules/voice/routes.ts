import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { typedRouteConfig } from '../../plugins/validation';
import { deleteVoiceProfile, enrollVoice, getVoiceProfile, updateVoiceProfile, verifyVoice } from './service';
import { AUDIO_UPLOAD_LIMITS, readUpload } from './upload';

const accountIdOf = (request: FastifyRequest) => (request.user as { userId: string }).userId;

const deleteProfileSchema = z.object({
    body: z.object({ password: z.string().min(1).max(128) }),
});

/**
 * Voice profile ("Giọng nói", docs/architecture/voice.md). Uploads are
 * multipart/form-data with 16 kHz mono WAV recordings.
 */
const voiceRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
    // Scoped to these routes: the rest of the API stays JSON-only.
    await app.register(multipart, { limits: AUDIO_UPLOAD_LIMITS });

    app.get('/voice/profile', {
        preHandler: [app.authenticate],
    }, async (request) => ({ success: true, ...(await getVoiceProfile(app, accountIdOf(request))) }));

    // ambient: 2 s of silence; samples: 3 to 5 sentences; consent=true.
    app.post('/voice/profile', {
        preHandler: [app.authenticate],
        config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
    }, async (request) => {
        const { files, fields } = await readUpload(request, { ambient: 1, samples: 5 });
        return { success: true, profile: await enrollVoice(app, accountIdOf(request), files, fields.consent === 'true') };
    });

    app.delete('/voice/profile', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({ zodSchema: deleteProfileSchema, rateLimit: { max: 5, timeWindow: '1 minute' } }),
    }, async (request) => {
        await deleteVoiceProfile(app, accountIdOf(request), (request.body as { password: string }).password);
        return { success: true };
    });

    app.post('/voice/verify', {
        preHandler: [app.authenticate],
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    }, async (request) => {
        const { files } = await readUpload(request, { audio: 1 });
        return { success: true, ...(await verifyVoice(app, accountIdOf(request), files[0])) };
    });

    app.post('/voice/calibrate', {
        preHandler: [app.authenticate],
        config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
    }, async (request) => {
        const { files } = await readUpload(request, { samples: 5 });
        return { success: true, ...(await updateVoiceProfile(app, accountIdOf(request), 'calibrate', files) as object) };
    });

    app.post('/voice/samples', {
        preHandler: [app.authenticate],
        config: { rateLimit: { max: 30, timeWindow: '1 hour' } },
    }, async (request) => {
        const { files } = await readUpload(request, { audio: 1 });
        return { success: true, profile: await updateVoiceProfile(app, accountIdOf(request), 'samples', files) };
    });

    // Replays of the owner's voice (another phone's speaker): the anti-spoof model learns them.
    app.post('/voice/antispoof', {
        preHandler: [app.authenticate],
        config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
    }, async (request) => {
        const { files } = await readUpload(request, { samples: 5 });
        return { success: true, profile: await updateVoiceProfile(app, accountIdOf(request), 'antispoof', files) };
    });
};

export default voiceRoutes;
