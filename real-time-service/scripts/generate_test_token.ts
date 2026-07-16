import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || 'change_me';
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const MONGO_DB_NAME = process.env.MONGO_DB_NAME || 'SmartHomeDB';

async function generateToken() {
    let userId = process.argv[2];

    const client = new MongoClient(MONGO_URI);
    
    try {
        if (!userId) {
            console.log('No userId provided. Looking up an existing device owner in MongoDB...');
            await client.connect();
            const db = client.db(MONGO_DB_NAME);
            const device = await db.collection('devices').findOne({});
            if (device && device.owner_id) {
                userId = device.owner_id;
                console.log(`Found owner_id: ${userId}`);
            } else {
                userId = 'test_user_123';
                console.log(`No devices found. Using default: ${userId}`);
            }
        }

        const token = jwt.sign({ userId, email: 'test@example.com' }, JWT_SECRET, { expiresIn: '1y' });
        console.log('\n=============================================');
        console.log('✅ JWT Test Token generated successfully');
        console.log('UserId:', userId);
        console.log('Token:\n' + token);
        console.log('=============================================\n');
    } catch (e) {
        console.error('Error generating token:', e);
    } finally {
        await client.close();
    }
}

generateToken();
