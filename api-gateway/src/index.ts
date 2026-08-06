import 'dotenv/config';
import { env } from './config/env';
import { buildApp } from './app';
import { syncOwnershipToRedis } from './modules/device/service';
import { OperationStatusConsumer } from './workers/operationStatusConsumer';
import { OperationOutboxDispatcher } from './workers/operationOutboxDispatcher';
import {
    DeviceShadowOutboxDispatcher,
    synchronizeDeviceShadowAccessProjection,
} from './workers/deviceShadowOutboxDispatcher';
import {
    synchronizeTopologyCache,
    TopologyOutboxDispatcher,
} from './workers/topologyOutboxDispatcher';
import { TopologyCoordinator } from './workers/topologyCoordinator';
import { RuntimeCatalog } from '../../shared/catalog-v2';
import { CredentialOutboxDispatcher } from './workers/credentialOutboxDispatcher';
import { CredentialStatusConsumer } from './workers/credentialStatusConsumer';

const app = buildApp();

const port = env.PORT;
const host = env.HOST;

const start = async () => {
    try {
        let statusConsumer: OperationStatusConsumer | null = null;
        let outboxDispatcher: OperationOutboxDispatcher | null = null;
        let shadowOutboxDispatcher: DeviceShadowOutboxDispatcher | null = null;
        let topologyOutboxDispatcher: TopologyOutboxDispatcher | null = null;
        let topologyCoordinator: TopologyCoordinator | null = null;
        let credentialOutboxDispatcher: CredentialOutboxDispatcher | null = null;
        let credentialStatusConsumer: CredentialStatusConsumer | null = null;

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
            if (credentialOutboxDispatcher) {
                await credentialOutboxDispatcher.stop();
            }
            if (credentialStatusConsumer) {
                await credentialStatusConsumer.stop();
            }
        });

        app.decorate('catalog', null as unknown as RuntimeCatalog);

        // Load all plugins and decorators first
        await app.ready();

        const catalog = new RuntimeCatalog({ log: app.log });
        await catalog.start();
        (app as any).catalog = catalog;

        await synchronizeDeviceShadowAccessProjection(
            app.pg,
            app.mongo.db,
            catalog,
            app.log,
        );

        // Đồng bộ vòng đời operation bất đồng bộ từ MQTT Worker.
        statusConsumer = new OperationStatusConsumer(app.pg, app.redis, app.log, app.mongo.db);
        await statusConsumer.start();

        // Operations use a PostgreSQL outbox so a Redis outage cannot lose them.
        outboxDispatcher = new OperationOutboxDispatcher(
            app.pg,
            app.redis,
            app.mongo.db,
            app.log,
        );
        outboxDispatcher.start();
        credentialStatusConsumer = new CredentialStatusConsumer(app.pg, app.redis, app.log);
        await credentialStatusConsumer.start();
        credentialOutboxDispatcher = new CredentialOutboxDispatcher(app.pg, app.redis, app.log);
        credentialOutboxDispatcher.start();
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
