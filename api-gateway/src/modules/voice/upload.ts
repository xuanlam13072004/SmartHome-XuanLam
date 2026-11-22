import type { FastifyRequest } from 'fastify';
import { httpError } from '../../utils/httpError';
import type { AudioPart } from './client';

/** 16 kHz mono 16-bit WAV is 32 KB per second; recordings last at most 15 s. */
const MAX_AUDIO_BYTES = 1024 * 1024;

/** @fastify/multipart limits for routes that accept recordings. */
export const AUDIO_UPLOAD_LIMITS = { fileSize: MAX_AUDIO_BYTES, files: 6, fields: 4, parts: 10, fieldSize: 64 };

/**
 * Reads a multipart upload: only the expected file fields, each at most
 * `max` times, every file at most 1 MB. voice-service checks the audio itself.
 */
export async function readUpload(request: FastifyRequest, expected: Record<string, number>) {
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
