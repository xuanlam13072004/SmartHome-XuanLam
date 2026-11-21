import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { typedRouteConfig } from '../../plugins/validation';
import { httpError } from '../../utils/httpError';
import type { AudioPart } from './client';
import { deleteVoiceProfile, enrollVoice, getVoiceProfile, updateVoiceProfile, verifyVoice } from './service';

const accountIdOf = (request: FastifyRequest) => (request.user as { userId: string }).userId;

/** 16 kHz mono 16-bit WAV is 32 KB per second; recordings last at most 15 s. */
const MAX_AUDIO_BYTES = 1024 * 1024;

const deleteProfileSchema = z.object({
    body: z.object({ password: z.string().min(1).max(128) }),
});

/**
 * Reads the multipart upload: only the expected file fields, each at most
 * `max` times, every file at most 1 MB. voice-service checks the audio itself.
 */
async function readUpload(request: FastifyRequest, expected: Record<string, number>) {
    const files: AudioPart[] = [];
    const fields: Record<string, string> = {};
    try {
        for await (const part of request.parts()) {
            if (part.type === 'file') {
                const max = expected[part.fieldname];
                if (!max || files.filter(file => file.field === part.fieldname).length >= max) {
                    throw httpError(400, 'VOICE_BAD_REQUEST', `Trường "${part.fieldname}" không hợp lệ hoặc quá nhiều file.`);
                }
                files.push({ field: part.fieldname, filename: `${part.fieldname}-${files.length}.wav`, data: await part.toBuffer() });
            } else {
                fields[part.fieldname] = String(part.value);
            }
        }
    } catch (error: any) {
        if (error?.code === 'FST_REQ_FILE_TOO_LARGE') {
            throw httpError(413, 'VOICE_FILE_TOO_LARGE', 'File ghi âm quá lớn (tối đa 1 MB).');
        }
        if (typeof error?.code === 'string' && error.code.startsWith('FST_')) {
            throw httpError(400, 'VOICE_BAD_REQUEST', 'Dữ liệu ghi âm không hợp lệ.');
        }
        throw error;
    }
    for (const field of Object.keys(expected)) {
        if (!files.some(file => file.field === field)) {
            throw httpError(400, 'VOICE_BAD_REQUEST', `Thiếu file ghi âm "${field}".`);
        }
    }
    return { files, fields };
}

/**
 * Voice profile ("Giọng nói", docs/architecture/voice.md). Uploads are
 * multipart/form-data with 16 kHz mono WAV recordings.
 */
const voiceRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
    // Scoped to these routes: the rest of the API stays JSON-only.
    await app.register(multipart, {
        limits: { fileSize: MAX_AUDIO_BYTES, files: 6, fields: 4, parts: 10, fieldSize: 64 },
    });

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
