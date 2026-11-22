import crypto from 'node:crypto';

/**
 * VietQR (NAPAS 247) bank-transfer QR, built here so no third-party service
 * sees the order: an EMVCo merchant-presented payload any Vietnamese banking
 * app opens with the account, amount and transfer note filled in.
 */

function field(id: string, value: string): string {
    if (value.length > 99) throw new Error(`EMVCo field ${id} is too long`);
    return `${id}${String(value.length).padStart(2, '0')}${value}`;
}

/** CRC-16/CCITT-FALSE (poly 0x1021, initial 0xFFFF), as EMVCo requires. */
export function crc16(text: string): string {
    let crc = 0xffff;
    for (const byte of Buffer.from(text, 'utf8')) {
        crc ^= byte << 8;
        for (let bit = 0; bit < 8; bit += 1) {
            crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
        }
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
}

export function buildVietQr(input: { bin: string; account: string; amount?: number; note?: string }): string {
    if (!/^\d{6}$/.test(input.bin)) throw new Error('Bank BIN must have 6 digits');
    if (!/^[0-9A-Za-z]{1,19}$/.test(input.account)) throw new Error('Invalid account number');
    if (input.note !== undefined && !/^[0-9A-Za-z ]{1,25}$/.test(input.note)) throw new Error('Invalid transfer note');
    const beneficiary = field('00', input.bin) + field('01', input.account);
    const merchant = field('00', 'A000000727') + field('01', beneficiary) + field('02', 'QRIBFTTA');
    const payload = field('00', '01')
        + field('01', input.amount ? '12' : '11')
        + field('38', merchant)
        + field('53', '704')
        + (input.amount ? field('54', String(Math.round(input.amount))) : '')
        + field('58', 'VN')
        + (input.note ? field('62', field('08', input.note)) : '')
        + '6304';
    return payload + crc16(payload);
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 symbols: no 0/O, 1/I
const CODE = /SH[A-HJ-NP-Z2-9]{8}/;

/** "SH" + 8 random symbols (40 bits): short to type, impossible to guess. */
export function newOrderCode(): string {
    return `SH${[...crypto.randomBytes(8)].map(byte => ALPHABET[byte % 32]).join('')}`;
}

/** The order code in a bank transfer note; banks may drop or add spaces and dots. */
export function findOrderCode(text: string): string | null {
    const upper = text.toUpperCase();
    return upper.match(CODE)?.[0] ?? upper.replace(/[^A-Z0-9]/g, '').match(CODE)?.[0] ?? null;
}

export function isOrderCode(text: string): boolean {
    return /^SH[A-HJ-NP-Z2-9]{8}$/.test(text);
}
