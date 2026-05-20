import 'fastify';
import type { Pool } from 'pg';
import type Redis from 'ioredis';
import type { Db, MongoClient } from 'mongodb';

declare module 'fastify' {
    interface FastifyInstance {
        pg: Pool;
        redis: Redis;
        mongo: {
            client: MongoClient;
            db: Db;
        };
    }
}
