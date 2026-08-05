import 'fastify';
import type { Pool } from 'pg';
import type Redis from 'ioredis';
import type { Db, MongoClient } from 'mongodb';
import type { RuntimeCatalog } from '../../../shared/catalog-v2';

declare module 'fastify' {
    interface FastifyInstance {
        pg: Pool;
        redis: Redis;
        mongo: {
            client: MongoClient;
            db: Db;
        };
        catalog: RuntimeCatalog;
    }
}
