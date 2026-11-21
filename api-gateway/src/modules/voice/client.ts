import { env } from '../../config/env';
import { httpError } from '../../utils/httpError';

/**
 * HTTP client of voice-service (docs/architecture/voice.md). Only the
 * Gateway talks to it, inside the Docker network, with a shared token.
 * Its errors keep their code, Vietnamese message and details (which
 * recording failed); an unreachable or failing service is 503.
 */

export interface AudioPart {
    field: string;
    filename: string;
    data: Buffer;
}

function unavailable() {
    return httpError(503, 'VOICE_UNAVAILABLE', 'Dịch vụ giọng nói đang tạm dừng, hãy thử lại sau.');
}

export async function voiceRequest<T>(
    method: 'GET' | 'PUT' | 'POST' | 'DELETE',
    path: string,
    input: { files?: AudioPart[]; fields?: Record<string, string>; timeoutMs?: number } = {},
): Promise<T | null> {
    if (!env.VOICE_SERVICE_TOKEN) throw unavailable();
    let body: FormData | undefined;
    if (input.files || input.fields) {
        body = new FormData();
        for (const [name, value] of Object.entries(input.fields ?? {})) body.append(name, value);
        for (const file of input.files ?? []) {
            body.append(file.field, new Blob([new Uint8Array(file.data)], { type: 'audio/wav' }), file.filename);
        }
    }
    let response: Response;
    try {
        response = await fetch(`${env.VOICE_SERVICE_URL}${path}`, {
            method,
            body,
            headers: { 'x-voice-token': env.VOICE_SERVICE_TOKEN },
            signal: AbortSignal.timeout(input.timeoutMs ?? 30_000),
        });
    } catch {
        throw unavailable();
    }
    if (response.status === 204) return null;
    const json = await response.json().catch(() => null) as any;
    if (response.ok) return json as T;
    const error = json?.error;
    // 401 means the two services disagree on the token: a deployment problem, not the user's.
    if (response.status >= 500 || response.status === 401 || typeof error?.code !== 'string') throw unavailable();
    const failure = httpError(response.status, error.code, String(error.message ?? error.code)) as any;
    if (error.details && Object.keys(error.details).length > 0) failure.details = error.details;
    throw failure;
}
