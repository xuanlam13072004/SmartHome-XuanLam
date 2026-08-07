export interface StartupRetryOptions {
    attempts: number;
    delayMs: number;
    wait?: (delayMs: number) => Promise<void>;
    onRetry?: (context: {
        name: string;
        attempt: number;
        attempts: number;
        delayMs: number;
        error: unknown;
    }) => void;
}

const defaultWait = (delayMs: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, delayMs));

export const retryStartupDependency = async <T>(
    name: string,
    operation: () => Promise<T>,
    options: StartupRetryOptions,
): Promise<T> => {
    const attempts = Math.max(1, Math.trunc(options.attempts));
    const delayMs = Math.max(0, Math.trunc(options.delayMs));
    const wait = options.wait || defaultWait;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            if (attempt >= attempts) break;
            options.onRetry?.({ name, attempt, attempts, delayMs, error });
            await wait(delayMs);
        }
    }

    throw new Error(
        `${name} is unavailable after ${attempts} startup attempts`,
        { cause: lastError },
    );
};
