import 'dotenv/config';
import { env } from './config/env';
import { buildApp } from './app';
import { syncOwnershipToRedis } from './modules/device/service';
import { CommandStatusConsumer } from './workers/commandStatusConsumer';

const app = buildApp();

const port = env.PORT;
const host = env.HOST;

const start = async () => {
    try {
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

        // Khởi động Command Status Consumer để cập nhật trạng thái lệnh không đồng bộ
        const statusConsumer = new CommandStatusConsumer(app.pg, app.redis, app.log);
        await statusConsumer.start();

        // Đăng ký hook dừng Consumer khi app đóng
        app.addHook('onClose', async () => {
            await statusConsumer.stop();
        });
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
};

start();
