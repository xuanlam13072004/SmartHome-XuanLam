import { env } from '../../config/env';
import { httpError } from '../../utils/httpError';

/**
 * Gemini generateContent over REST (no SDK): one call per assistant turn,
 * two when the user asks about history (the facts looked up, then the answer).
 * Commands come back as function calls; the reply of a turn that runs
 * commands is written by the server.
 */

export interface ChatMessage {
    role: 'user' | 'model';
    text: string;
    /** The assistant asked a question back: the next user message may answer it. */
    clarify?: boolean;
    /** The assistant answered from looked-up history: a follow-up ("còn hôm kia?") may ask again. */
    history?: boolean;
}

export interface GeminiRequest {
    system: string;
    contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }>;
    functions: unknown[];
}

export interface GeminiCall {
    name: string;
    args: Record<string, unknown>;
}

export interface GeminiResult {
    text: string | null;
    calls: GeminiCall[];
    tokens: number;
    blocked: boolean;
}

export type GenerateFn = (request: GeminiRequest) => Promise<GeminiResult>;

function unavailable(message = 'Trợ lý đang tạm dừng, hãy thử lại sau.') {
    return httpError(503, 'ASSISTANT_UNAVAILABLE', message);
}

export function parseGeminiResponse(body: any): GeminiResult {
    const candidate = body?.candidates?.[0];
    const parts: any[] = candidate?.content?.parts ?? [];
    const text = parts.filter(part => typeof part.text === 'string' && !part.thought).map(part => part.text).join('').trim();
    const calls = parts
        .filter(part => part.functionCall && typeof part.functionCall.name === 'string')
        .map(part => ({
            name: part.functionCall.name as string,
            args: part.functionCall.args && typeof part.functionCall.args === 'object' ? part.functionCall.args : {},
        }));
    const usage = body?.usageMetadata ?? {};
    const tokens = Number(usage.totalTokenCount)
        || Number(usage.promptTokenCount ?? 0) + Number(usage.candidatesTokenCount ?? 0) + Number(usage.thoughtsTokenCount ?? 0);
    const blocked = Boolean(body?.promptFeedback?.blockReason)
        || ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION'].includes(candidate?.finishReason);
    return { text: text || null, calls, tokens: Number.isFinite(tokens) ? tokens : 0, blocked };
}

export function geminiGenerate(log: { warn: (obj: unknown, msg: string) => void }): GenerateFn {
    return async (request) => {
        if (!env.GEMINI_API_KEY) throw unavailable('Trợ lý chưa được cấu hình (thiếu khóa Gemini).');
        const body = {
            systemInstruction: { parts: [{ text: request.system }] },
            contents: request.contents,
            // The answer from looked-up history is plain text: no functions then.
            ...(request.functions.length > 0 ? {
                tools: [{ functionDeclarations: request.functions }],
                toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
            } : {}),
            generationConfig: {
                // Thinking tokens count towards this limit.
                maxOutputTokens: 2048,
                ...(env.GEMINI_THINKING_LEVEL ? { thinkingConfig: { thinkingLevel: env.GEMINI_THINKING_LEVEL } } : {}),
            },
        };
        let response: Response;
        try {
            response = await fetch(`${env.GEMINI_API_URL}/models/${env.GEMINI_MODEL}:generateContent`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(25_000),
            });
        } catch {
            throw unavailable();
        }
        const json = await response.json().catch(() => null) as any;
        if (response.status === 429) {
            throw httpError(503, 'ASSISTANT_BUSY', 'Trợ lý đang quá tải, hãy thử lại sau ít phút.');
        }
        if (!response.ok) {
            log.warn({ status: response.status, error: json?.error?.message }, 'Gemini request failed');
            throw unavailable();
        }
        return parseGeminiResponse(json);
    };
}
