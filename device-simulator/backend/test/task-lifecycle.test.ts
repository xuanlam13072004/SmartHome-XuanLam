import assert from 'node:assert/strict';
import test from 'node:test';
import { GenerationTaskLifecycle } from '../src/generation/task-lifecycle';

test('pause waits for in-flight work and rapid resume never starts a second worker', async () => {
    const tasks = new GenerationTaskLifecycle();
    let release!: () => void;
    let workers = 0;
    const running = tasks.run('run', async () => {
        workers++;
        await new Promise<void>(resolve => { release = resolve; });
    });
    await Promise.resolve();
    let stopped = false;
    const stop = tasks.stop('run').then(() => { stopped = true; });
    assert.equal(tasks.isActive('run'), false);
    await tasks.run('run', async () => { workers++; });
    assert.equal(workers, 1);
    assert.equal(stopped, false);
    release();
    await Promise.all([running, stop]);
    await tasks.run('run', async () => { workers++; });
    assert.equal(workers, 2);
});

test('failed work releases its slot and shutdown cancels all workers', async () => {
    const tasks = new GenerationTaskLifecycle();
    await assert.rejects(tasks.run('run', async () => { throw new Error('dependency failed'); }));
    let entered = false;
    const run = tasks.run('run', async () => { entered = tasks.isActive('run'); });
    await tasks.stopAll();
    await run;
    assert.equal(entered, false);
    assert.equal(tasks.isActive('run'), false);
});
