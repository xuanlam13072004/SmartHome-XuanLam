import { buildConsole } from './app';
import { loadConfig } from './config';

async function main() {
    const config = loadConfig();
    const app = await buildConsole(config);
    await app.listen({ port: config.PORT, host: config.HOST });
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.once(signal, () => void app.close().then(() => process.exit(0)));
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
