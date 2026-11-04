// Imported first by tests so config/env.ts validates without a .env file.
process.env.JWT_SECRET ||= 'test-secret-value-1234567890';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:1';
process.env.REDIS_URL ||= 'redis://127.0.0.1:1';
process.env.API_GATEWAY_URL ||= 'http://127.0.0.1:1';
