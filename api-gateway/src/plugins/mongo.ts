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

    const deviceEvents = client
        .db(env.MONGO_DB_NAME)
        .collection(env.MONGO_DEVICE_EVENTS_COLLECTION);
    await Promise.all([
        deviceEvents.createIndex(
            { device_id: 1, event_id: 1 },
            { unique: true, name: 'device_event_identity_unique' },
        ),
        deviceEvents.createIndex(
            { device_id: 1, received_at: -1, _id: -1 },
            { name: 'device_event_device_timeline' },
        ),
        deviceEvents.createIndex(
            { owner_id: 1, received_at: -1 },
            { name: 'device_event_owner_timeline' },
        ),
    ]);

    app.addHook('onClose', async () => {
        await client.close();
    });
};

export default fp(mongoPlugin, {
    name: 'mongo-plugin',
});
