import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { MongoClient } from 'mongodb';
import { env } from '../config/env';

/**
 * mongoPlugin
 * - Kết nối MongoDB
 * - Ping để xác nhận kết nối
 * - Gắn client + db vào fastify instance
 */
const mongoPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
    const client = new MongoClient(env.MONGO_URI);

    await client.connect();
    await client.db(env.MONGO_DB_NAME).command({ ping: 1 });

    app.decorate('mongo', {
        client,
        db: client.db(env.MONGO_DB_NAME),
    });

    app.addHook('onClose', async () => {
        await client.close();
    });
};

export default fp(mongoPlugin, {
    name: 'mongo-plugin',
});
