import { setTimeout as sleep } from 'node:timers/promises';

export interface RequestOptions {
    signal?: AbortSignal;
    onRateLimit?: (info: { path: string; attempt: number; delayMs: number }) => Promise<void> | void;
}

export function retryDelayMs(headers: Headers, message: string, now = Date.now()): number {
    const retryAfter = headers.get('retry-after');
    if (retryAfter !== null) {
        const seconds = Number(retryAfter);
        if (retryAfter.trim() && Number.isFinite(seconds) && seconds >= 0) return Math.max(1000, seconds * 1000 + 250);
        const date = Date.parse(retryAfter);
        if (Number.isFinite(date)) return Math.max(1000, date - now + 250);
    }
    const match = /retry in\s+(\d+(?:\.\d+)?)\s+seconds?/i.exec(message);
    return match ? Math.max(1000, Number(match[1]) * 1000 + 250) : 60_250;
}

/** Retry only explicit throttling responses; ambiguous network failures are not replayed. */
export async function fetchWithRateLimitRetry(
    url: string,
    init: RequestInit,
    options: RequestOptions & {
        timeoutMs: number;
        maxRetries?: number;
        fetch?: typeof fetch;
        wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
        now?: () => number;
    },
): Promise<Response> {
    const request = options.fetch ?? fetch;
    const wait = options.wait ?? ((ms, signal) => sleep(ms, undefined, { signal }));
    for (let attempt = 0; ; attempt++) {
        options.signal?.throwIfAborted();
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), options.timeoutMs);
        let response: Response;
        try {
            response = await request(url, {
                ...init,
                signal: options.signal
                    ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal,
            });
            // Read the body within the request timeout, including stalled response bodies.
            const body = await response.text();
            response = new Response(body || null, { status: response.status, headers: response.headers });
        } finally {
            clearTimeout(timer);
        }
        if (response.status !== 429 || attempt >= (options.maxRetries ?? 5)) return response;
        const delayMs = retryDelayMs(response.headers, await response.clone().text(), options.now?.());
        await options.onRateLimit?.({ path: new URL(url).pathname, attempt: attempt + 1, delayMs });
        await wait(delayMs, options.signal);
    }
}
