import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { Pool } from 'pg';
import { env } from '../config/env';

/**
 * postgresPlugin
 * - Tạo Pool kết nối PostgreSQL
 * - Ping DB để đảm bảo kết nối thật sự hoạt động
 * - Gắn pool vào fastify instance để dùng trong handler
 *
 * Production notes:
 * - Pool giúp tái sử dụng connection, tránh mở/đóng liên tục
 * - Dùng SSL khi deploy production (PG_SSL=true)
 * - Fail fast nếu DB không reachable
 */
const postgresPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
    const pool = new Pool({
        host: env.PG_HOST,
        port: env.PG_PORT,
        database: env.PG_DATABASE,
        user: env.PG_USER,
        password: env.PG_PASSWORD,
        ssl: env.PG_SSL ? { rejectUnauthorized: false } : false,
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
    });

    // Ping DB để chắc chắn kết nối ổn
    await pool.query('SELECT 1');

    // Gắn pool vào app để route handler dùng
    app.decorate('pg', pool);

    // Khi app đóng, đóng pool
    app.addHook('onClose', async () => {
        await pool.end();
    });
};

export default fp(postgresPlugin, {
    name: 'postgres-plugin',
});
