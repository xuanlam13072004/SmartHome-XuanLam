import 'dotenv/config';
import { env } from './config/env';
import { buildApp } from './app';

const app = buildApp();

const port = env.PORT;
const host = env.HOST;

const start = async () => {
    try {
        await app.listen({ port, host });
        app.log.info(`API Gateway listening on ${host}:${port}`);
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
};

start();
