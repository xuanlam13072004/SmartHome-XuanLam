const { Pool } = require('pg');

/**
 * Tác dụng của file này:
 * - Tách toàn bộ logic tạo PostgreSQL Pool ra khỏi src/index.js
 * - Giúp index.js chỉ còn vai trò điều phối khởi động/shutdown
 * - Sau này nếu đổi cấu hình kết nối, pool size hoặc thêm helper query thì sửa ở đây
 *
 * Ý tưởng thiết kế:
 * - Hàm createPostgresPool nhận config + logger
 * - Tạo Pool từ pg
 * - Chạy SELECT 1 để verify kết nối
 * - Trả về pool để file khác dùng
 */
async function createPostgresPool({ host, port, database, user, password, ssl, logger }) {
    const pool = new Pool({
        host,
        port,
        database,
        user,
        password,
        ssl: ssl ? { rejectUnauthorized: false } : false,
        max: 10,
        idleTimeoutMillis: 30000,
    });

    await pool.query('SELECT 1');
    logger.info({ db: database }, 'PostgreSQL connected');

    return pool;
}

module.exports = {
    createPostgresPool,
};
