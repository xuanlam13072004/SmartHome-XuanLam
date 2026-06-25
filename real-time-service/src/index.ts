import dns from 'dns';

// Fix Node.js SRV lookup issues by using Google's public DNS servers
try {
    dns.setServers(['8.8.8.8', '8.8.4.4']);
    console.log('📡 DNS servers set to Google Public DNS.');
} catch (dnsErr) {
    console.warn('⚠️ Failed to set custom DNS servers:', dnsErr);
}

import { connectMongo, closeMongo } from './loaders/mongo.js';
import { initRedis, closeRedis } from './loaders/redis.js';
import { startRedisPubSubListener } from './services/redisPubSub.js';
import { startServer, stopServer } from './server.js';

async function bootstrap() {
    console.log('⚡ Bootstrapping Realtime WebSocket Service...');
    try {
        // 1. Connect MongoDB
        await connectMongo();

        // 2. Initialize Redis clients
        initRedis();

        // 3. Start Redis Pub/Sub subscriber
        startRedisPubSubListener();

        // 4. Start HTTP/WS server
        await startServer();

        console.log('✅ Realtime WebSocket Service successfully started.');
    } catch (err) {
        console.error('❌ Critical error during bootstrap:', err);
        await shutdown();
        process.exit(1);
    }
}

async function shutdown() {
    console.log('⚙️ Gracefully shutting down Realtime WebSocket Service...');
    try {
        await stopServer();
        await closeRedis();
        await closeMongo();
        console.log('👋 Service shutdown complete.');
    } catch (err) {
        console.error('❌ Error during shutdown:', err);
    }
}

// Handle termination signals
process.on('SIGTERM', async () => {
    console.log('Received SIGTERM signal.');
    await shutdown();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('Received SIGINT signal.');
    await shutdown();
    process.exit(0);
});

// Run bootstrap
bootstrap();
