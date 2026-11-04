import crypto from 'node:crypto';
import type { SimulatedDeviceRecord } from '../domain/registry';
import { getMongoDb } from '../infrastructure/mongodb/client';
import { decrypt, encrypt } from './crypto';

export const ENTRANCE_PRODUCT_ID = 'prod_entrance_controller';
export const ACCESS_PIN_LENGTH = 6;

export const generateAccessPin = (): string =>
    crypto.randomInt(0, 1_000_000).toString().padStart(ACCESS_PIN_LENGTH, '0');

export const decryptAccessPin = (device: SimulatedDeviceRecord): string | undefined => {
    if (!device.access_pin) return undefined;
    return decrypt(
        device.access_pin.iv,
        device.access_pin.encrypted,
        device.access_pin.authTag,
    );
};

export const ensureAccessPin = async (
    device: SimulatedDeviceRecord,
): Promise<string | undefined> => {
    if (device.product_id !== ENTRANCE_PRODUCT_ID) return undefined;
    const existing = decryptAccessPin(device);
    if (existing) return existing;

    const pin = generateAccessPin();
    const encrypted = encrypt(pin);
    const collection = getMongoDb().collection<SimulatedDeviceRecord>('simulated_devices');
    const result = await collection.updateOne(
        { mac: device.mac, access_pin: { $exists: false } },
        { $set: { access_pin: encrypted, updated_at: new Date() } },
    );
    if (result.modifiedCount === 1) {
        device.access_pin = encrypted;
        return pin;
    }

    // Another request may have initialized this legacy record first. Never
    // return our losing candidate because the runtime and detail screen would
    // then disagree about the PIN that is actually persisted.
    const stored = await collection.findOne(
        { mac: device.mac },
        { projection: { access_pin: 1 } },
    );
    if (!stored?.access_pin) {
        throw new Error('Could not initialize the virtual entrance access PIN');
    }
    device.access_pin = stored.access_pin;
    return decryptAccessPin(device);
};
