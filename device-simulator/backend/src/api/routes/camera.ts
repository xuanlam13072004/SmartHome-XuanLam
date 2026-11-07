import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { parseChunkBatch } from '../../media/chunk-batch';
import { aacLcAudioSpecificConfig } from '../../media/fmp4';
import { getRuntimeManager } from '../../runtime/manager';
import { getDeviceContext, getOrCreateRuntime } from './devices';

/**
 * Dashboard-only routes for the virtual camera "sensor" (webcam/microphone)
 * and the administrator's view of the virtual SD card. The SmartHome backend
 * and Flutter never use these; they talk to the camera over MQTT and the
 * media relay like with a physical camera.
 */

const MAX_DESCRIPTION_BYTES = 4096;
const base64Bytes = (maxBytes: number) => z.string().max(Math.ceil(maxBytes / 3) * 4 + 4)
    .transform((value, context) => {
        const bytes = Buffer.from(value, 'base64');
        if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
            context.addIssue({ code: 'custom', message: 'Decoder configuration is invalid' });
            return z.NEVER;
        }
        return new Uint8Array(bytes);
    });

const sourceSchema = z.discriminatedUnion('action', [
    z.object({
        action: z.literal('start'),
        session_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
        force: z.boolean().default(false),
        video: z.object({
            codec: z.string().regex(/^avc1\.[0-9A-Fa-f]{6}$/),
            width: z.number().int().min(160).max(1920),
            height: z.number().int().min(120).max(1080),
            framerate: z.number().min(1).max(30.5),
            description: base64Bytes(MAX_DESCRIPTION_BYTES),
        }).strict(),
        audio: z.object({
            codec: z.literal('mp4a.40.2'),
            sample_rate: z.union([z.literal(48000), z.literal(44100), z.literal(32000), z.literal(16000)]),
            channels: z.union([z.literal(1), z.literal(2)]),
            description: base64Bytes(64).optional(),
        }).strict().nullable(),
    }).strict(),
    z.object({
        action: z.literal('stop'),
        session_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
    }).strict(),
]);

const SEGMENT_ID = /^\d{8}-\d{6}$/;

const normalizeMac = (value: string): string => decodeURIComponent(value).trim().toUpperCase();

const fail = (reply: FastifyReply, status: number, code: string, message: string) =>
    reply.status(status).send({ success: false, error: { code, message } });

const cameraRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
    const runtimeManager = getRuntimeManager(app.log);
    app.addContentTypeParser(
        'application/octet-stream',
        { parseAs: 'buffer', bodyLimit: 16 * 1024 * 1024 },
        (_request, body, done) => done(null, body),
    );

    const cameraFor = async (mac: string, reply: FastifyReply, create: boolean) => {
        const runtime = runtimeManager.getDevice(mac) ?? (create ? await (async () => {
            const context = await getDeviceContext(mac);
            if (!context) return null;
            return getOrCreateRuntime(runtimeManager, context);
        })() : null);
        if (!runtime) {
            if (!(await getDeviceContext(mac))) {
                fail(reply, 404, 'DEVICE_NOT_FOUND', 'Device not found');
                return null;
            }
            fail(reply, 409, 'DEVICE_NOT_RUNNING', 'The virtual device is not running');
            return null;
        }
        const camera = runtime.securityCamera;
        if (!camera) {
            fail(reply, 409, 'NOT_A_CAMERA', 'This Product has no camera firmware');
            return null;
        }
        return camera;
    };

    app.get('/api/devices/:mac/camera', async (request, reply) => {
        const mac = normalizeMac((request.params as { mac: string }).mac);
        const camera = await cameraFor(mac, reply, false);
        if (!camera) return reply;
        reply.header('Cache-Control', 'no-store');
        return {
            success: true,
            status: camera.status(),
            segments: camera.segments().slice(-500).reverse().map((segment) => ({
                id: segment.id,
                start: new Date(segment.startMs).toISOString(),
                end: new Date(segment.endMs).toISOString(),
                size: segment.size,
            })),
        };
    });

    app.post('/api/devices/:mac/camera/source', async (request, reply) => {
        const mac = normalizeMac((request.params as { mac: string }).mac);
        const parsed = sourceSchema.safeParse(request.body);
        if (!parsed.success) return reply.status(400).send({ success: false, error: parsed.error.flatten() });
        const camera = await cameraFor(mac, reply, parsed.data.action === 'start');
        if (!camera) return reply;
        if (parsed.data.action === 'stop') {
            await camera.stopSource(parsed.data.session_id, 'stopped_by_dashboard');
            return { success: true, status: camera.status() };
        }
        const { video, audio, session_id: sessionId, force } = parsed.data;
        if (video.description[0] !== 1) {
            return fail(reply, 400, 'INVALID_VIDEO_CONFIG', 'Video description must be an avcC record (avc format)');
        }
        try {
            await camera.startSource({
                sessionId,
                video: {
                    codec: video.codec,
                    width: video.width,
                    height: video.height,
                    framerate: video.framerate,
                    avcC: video.description,
                },
                audio: audio ? {
                    codec: audio.codec,
                    sampleRate: audio.sample_rate,
                    channels: audio.channels,
                    asc: audio.description ?? aacLcAudioSpecificConfig(audio.sample_rate, audio.channels),
                } : null,
            }, force);
        } catch (error) {
            const typed = error as Error & { statusCode?: number; code?: string };
            return fail(reply, typed.statusCode || 500, typed.code || 'CAMERA_SOURCE_FAILED', typed.message);
        }
        return { success: true, status: camera.status() };
    });

    app.post('/api/devices/:mac/camera/chunks', { bodyLimit: 16 * 1024 * 1024 }, async (request, reply) => {
        const mac = normalizeMac((request.params as { mac: string }).mac);
        const sessionId = String((request.query as { session_id?: string }).session_id || '');
        if (!Buffer.isBuffer(request.body)) {
            return fail(reply, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Send chunks as application/octet-stream');
        }
        const camera = await cameraFor(mac, reply, false);
        if (!camera) return reply;
        try {
            camera.pushChunks(sessionId, parseChunkBatch(request.body));
        } catch (error) {
            const typed = error as Error & { statusCode?: number; code?: string };
            return fail(reply, typed.statusCode || 400, typed.code || 'INVALID_MEDIA_CHUNKS', typed.message);
        }
        return reply.status(204).send();
    });

    app.get('/api/devices/:mac/camera/segments/:segmentId', async (request, reply) => {
        const params = request.params as { mac: string; segmentId: string };
        const mac = normalizeMac(params.mac);
        if (!SEGMENT_ID.test(params.segmentId)) return fail(reply, 400, 'INVALID_SEGMENT', 'Segment id is invalid');
        const camera = await cameraFor(mac, reply, false);
        if (!camera) return reply;
        const segment = camera.segments().find((item) => item.id === params.segmentId);
        if (!segment) return fail(reply, 404, 'SEGMENT_NOT_FOUND', 'Recording segment not found');
        reply.header('Content-Type', 'video/mp4');
        reply.header('Content-Length', String(segment.size));
        reply.header('Cache-Control', 'no-store');
        return reply.send(createReadStream(segment.path));
    });
};

export default cameraRoutes;
