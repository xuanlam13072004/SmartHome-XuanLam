import dns from 'dns';

// Fix Node.js SRV lookup issues by using Google's public DNS servers
try {
    dns.setServers(['8.8.8.8', '8.8.4.4']);
} catch (dnsErr) {
    console.warn('⚠️ Failed to set custom DNS servers:', dnsErr);
}

import 'dotenv/config';
import { env } from './config/env';
import { buildApp } from './app';
import { syncOwnershipToRedis } from './modules/device/service';
import { CommandStatusConsumer } from './workers/commandStatusConsumer';
import { CommandOutboxDispatcher } from './workers/commandOutboxDispatcher';
import { DeviceShadowOutboxDispatcher } from './workers/deviceShadowOutboxDispatcher';
import {
    synchronizeTopologyCache,
    TopologyOutboxDispatcher,
} from './workers/topologyOutboxDispatcher';
import { TopologyCoordinator } from './workers/topologyCoordinator';
import { CatalogCache } from '../../shared/catalogCache';

const app = buildApp();

const port = env.PORT;
const host = env.HOST;

const start = async () => {
    try {
        let statusConsumer: CommandStatusConsumer | null = null;
        let outboxDispatcher: CommandOutboxDispatcher | null = null;
        let shadowOutboxDispatcher: DeviceShadowOutboxDispatcher | null = null;
        let topologyOutboxDispatcher: TopologyOutboxDispatcher | null = null;
        let topologyCoordinator: TopologyCoordinator | null = null;

        // Đăng ký hook dừng Consumer khi app đóng (phải đăng ký trước khi ready/listen)
        app.addHook('onClose', async () => {
            if (statusConsumer) {
                await statusConsumer.stop();
            }
            if (outboxDispatcher) {
                await outboxDispatcher.stop();
            }
            if (shadowOutboxDispatcher) {
                await shadowOutboxDispatcher.stop();
            }
            if (topologyCoordinator) {
                await topologyCoordinator.stop();
            }
            if (topologyOutboxDispatcher) {
                await topologyOutboxDispatcher.stop();
            }
        });

        app.decorate('catalogCache', null as unknown as CatalogCache);

        // Load all plugins and decorators first
        await app.ready();

        // Khởi động Catalog Cache
        const catalogCache = new CatalogCache(app.mongo.db, app.redis, app.log);
        await catalogCache.start();
        (app as any).catalogCache = catalogCache;

        // Khởi động Command Status Consumer để cập nhật trạng thái lệnh không đồng bộ
        statusConsumer = new CommandStatusConsumer(app.pg, app.redis, app.log, app.mongo.db);
        await statusConsumer.start();

        // Commands are committed to PostgreSQL together with an outbox row, then
        // delivered to Redis asynchronously so a Redis outage cannot lose them.
        outboxDispatcher = new CommandOutboxDispatcher(app.pg, app.redis, app.log);
        outboxDispatcher.start();
        shadowOutboxDispatcher = new DeviceShadowOutboxDispatcher(
            app.pg,
            app.mongo.db,
            app.log
        );
        shadowOutboxDispatcher.start();
        await synchronizeTopologyCache(app.pg, app.redis, app.log);
        topologyOutboxDispatcher = new TopologyOutboxDispatcher(
            app.pg,
            app.redis,
            app.mongo.db,
            app.log
        );
        topologyOutboxDispatcher.start();
        topologyCoordinator = new TopologyCoordinator(
            app.pg,
            app.redis,
            app.log
        );
        await topologyCoordinator.start();

        // Start listening
        await app.listen({ port, host });
        app.log.info(`API Gateway listening on ${host}:${port}`);

        // Đồng bộ danh sách sở hữu thiết bị từ PostgreSQL sang Redis
        await syncOwnershipToRedis(app);

        // Tự động đồng bộ lại nếu Redis mất kết nối và kết nối lại thành công
        app.redis.on('ready', async () => {
            app.log.warn(
                'Redis reconnected. Re-synchronizing ownership and topology caches...'
            );
            try {
                await syncOwnershipToRedis(app);
                await synchronizeTopologyCache(app.pg, app.redis, app.log);
            } catch (err) {
                app.log.error(
                    { err },
                    'Failed to rebuild caches after Redis reconnect'
                );
            }
        });
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
};

start();
