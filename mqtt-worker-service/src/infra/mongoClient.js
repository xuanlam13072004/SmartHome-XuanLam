const { MongoClient } = require('mongodb');

/**
 * Tác dụng của file này:
 * - Tách toàn bộ logic kết nối MongoDB ra khỏi src/index.js
 * - Giúp index.js chỉ tập trung điều phối khởi động/shutdown
 * - Sau này nếu cần thêm helper lấy collection hoặc db handle thì làm ở đây
 *
 * Ý tưởng thiết kế:
 * - Hàm createMongoClient nhận config + logger
 * - Tạo client MongoDB
 * - Gắn event cơ bản để theo dõi trạng thái kết nối
 * - Trả về client để file khác dùng
 */
async function createMongoClient({ mongoUri, dbName, logger }) {
    const client = new MongoClient(mongoUri);

    client.on('topologyOpening', () => {
        logger.info('MongoDB topology opening');
    });

    client.on('topologyClosed', () => {
        logger.warn('MongoDB topology closed');
    });

    await client.connect();
    await client.db(dbName).command({ ping: 1 });

    logger.info({ db: dbName }, 'MongoDB connected');

    return client;
}

module.exports = {
    createMongoClient,
};
