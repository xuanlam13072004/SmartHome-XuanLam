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
import { CatalogCache } from './modules/device/catalogCache';

const app = buildApp();

const port = env.PORT;
const host = env.HOST;

const start = async () => {
    try {
        let statusConsumer: CommandStatusConsumer | null = null;

        // Đăng ký hook dừng Consumer khi app đóng (phải đăng ký trước khi ready/listen)
        app.addHook('onClose', async () => {
            if (statusConsumer) {
                await statusConsumer.stop();
            }
        });

        app.decorate('catalogCache', null);

        // Load all plugins and decorators first
        await app.ready();

        // Khởi động Catalog Cache
        const catalogCache = new CatalogCache(app.mongo.db, app.redis, app.log);
        await catalogCache.start();
        (app as any).catalogCache = catalogCache;

        // Khởi động Command Status Consumer để cập nhật trạng thái lệnh không đồng bộ
        statusConsumer = new CommandStatusConsumer(app.pg, app.redis, app.log, app.mongo.db);
        await statusConsumer.start();

        // Start listening
        await app.listen({ port, host });
        app.log.info(`API Gateway listening on ${host}:${port}`);

        // Đồng bộ danh sách sở hữu thiết bị từ PostgreSQL sang Redis
        await syncOwnershipToRedis(app);

        // Tự động đồng bộ lại nếu Redis mất kết nối và kết nối lại thành công
        let isInitial = true;
        app.redis.on('ready', async () => {
            if (isInitial) {
                isInitial = false;
                return;
            }
            app.log.warn('Redis reconnected. Re-synchronizing device ownership cache from PostgreSQL...');
            await syncOwnershipToRedis(app);
        });
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
};

start();
