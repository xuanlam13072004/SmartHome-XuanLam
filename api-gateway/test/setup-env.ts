// Imported first by tests so config/env.ts validates without a .env file.
process.env.JWT_SECRET ||= 'test-secret-value-1234567890';
process.env.PG_HOST ||= '127.0.0.1';
process.env.PG_DATABASE ||= 'test';
process.env.PG_USER ||= 'test';
process.env.PG_PASSWORD ||= 'test';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:1';
process.env.REDIS_URL ||= 'redis://127.0.0.1:1';
