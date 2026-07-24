import crypto from 'crypto';
import { env } from '../config/env';

const ALGORITHM = 'aes-256-gcm';
const KEY = Buffer.from(env.CREDENTIAL_ENCRYPTION_KEY, 'hex');

export const encrypt = (text: string): { iv: string; encrypted: string; authTag: string } => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
    
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const authTag = cipher.getAuthTag().toString('hex');
    
    return {
        iv: iv.toString('hex'),
        encrypted,
        authTag,
    };
};

export const decrypt = (iv: string, encrypted: string, authTag: string): string => {
    const decipher = crypto.createDecipheriv(
        ALGORITHM, 
        KEY, 
        Buffer.from(iv, 'hex')
    );
    
    decipher.setAuthTag(Buffer.from(authTag, 'hex'));
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
};
