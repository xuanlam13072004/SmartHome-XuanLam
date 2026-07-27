import crypto from 'node:crypto';

const digest = (value: string): Buffer =>
    crypto.createHash('sha256').update(value).digest();

export const deterministicUnit = (seed: string, scope: string): number =>
    digest(`${seed}:${scope}`).readUInt32BE(0) / 0x1_0000_0000;

export const deterministicInteger = (
    seed: string,
    scope: string,
    min: number,
    max: number,
): number => {
    if (max < min) throw new Error('Invalid deterministic integer range');
    return min + Math.floor(deterministicUnit(seed, scope) * (max - min + 1));
};

export const deterministicHex = (seed: string, scope: string, byteLength: number): string =>
    digest(`${seed}:${scope}`).subarray(0, byteLength).toString('hex');

export const deterministicMac = (seed: string, scope: string): string => {
    const bytes = Buffer.from(deterministicHex(seed, scope, 6), 'hex');
    bytes[0] = (bytes[0] | 0x02) & 0xFE;
    return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join(':').toUpperCase();
};
