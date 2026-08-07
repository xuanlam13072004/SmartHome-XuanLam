import assert from 'node:assert/strict';
import test from 'node:test';
import { retryStartupDependency } from '../src/startup/retry';

test('startup dependency succeeds after transient failures', async () => {
    let calls = 0;
    const waits: number[] = [];
    const retries: number[] = [];

    const result = await retryStartupDependency(
        'API Gateway',
        async () => {
            calls += 1;
            if (calls < 3) throw new Error('not ready');
            return 'ready';
        },
        {
            attempts: 4,
            delayMs: 250,
            wait: async (delayMs) => { waits.push(delayMs); },
            onRetry: ({ attempt }) => { retries.push(attempt); },
        },
    );

    assert.equal(result, 'ready');
    assert.equal(calls, 3);
    assert.deepEqual(waits, [250, 250]);
    assert.deepEqual(retries, [1, 2]);
});

test('startup dependency preserves the final failure as the cause', async () => {
    const finalError = new Error('still unavailable');

    await assert.rejects(
        retryStartupDependency(
            'MongoDB',
            async () => { throw finalError; },
            {
                attempts: 2,
                delayMs: 0,
                wait: async () => undefined,
            },
        ),
        (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /MongoDB is unavailable after 2 startup attempts/);
            assert.equal(error.cause, finalError);
            return true;
        },
    );
});
