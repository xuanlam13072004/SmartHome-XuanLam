/** A stopped generation retains its slot until its in-flight work has settled. */
export class GenerationTaskLifecycle {
    private readonly tasks = new Map<string, { cancelled: boolean; done: Promise<void>; controller: AbortController }>();

    signal(id: string): AbortSignal | undefined {
        return this.tasks.get(id)?.controller.signal;
    }

    isActive(id: string): boolean {
        const task = this.tasks.get(id);
        return Boolean(task && !task.cancelled);
    }

    run(id: string, action: () => Promise<void>): Promise<void> {
        if (this.tasks.has(id)) return Promise.resolve();
        const task = { cancelled: false, done: Promise.resolve(), controller: new AbortController() };
        task.done = Promise.resolve().then(action).finally(() => {
            if (this.tasks.get(id) === task) this.tasks.delete(id);
        });
        this.tasks.set(id, task);
        return task.done;
    }

    async stop(id: string): Promise<void> {
        const task = this.tasks.get(id);
        if (!task) return;
        task.cancelled = true;
        task.controller.abort();
        await task.done.catch(() => undefined);
    }

    async stopAll(): Promise<void> {
        await Promise.all([...this.tasks.keys()].map(id => this.stop(id)));
    }
}
