import './setup-env';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVietQr, crc16, findOrderCode, isOrderCode, newOrderCode } from '../src/modules/payments/vietqr';

test('CRC-16/CCITT-FALSE check value', () => {
    assert.equal(crc16('123456789'), '29B1');
});

test('VietQR payloads match published examples byte for byte', () => {
    // ACB 257678859, 10.000đ, note "Chuyen tien" (vietnam-qr-pay examples).
    assert.equal(
        buildVietQr({ bin: '970416', account: '257678859', amount: 10000, note: 'Chuyen tien' }),
        '00020101021238530010A0000007270123000697041601092576788590208QRIBFTTA53037045405100005802VN62150811Chuyen tien630453E6',
    );
    assert.equal(
        buildVietQr({ bin: '970416', account: '257678859' }),
        '00020101021138530010A0000007270123000697041601092576788590208QRIBFTTA53037045802VN6304AE9F',
    );
    assert.throws(() => buildVietQr({ bin: '97041', account: '1' }));
    assert.throws(() => buildVietQr({ bin: '970416', account: '1', note: 'Có dấu' }));
});

test('order codes are short, unambiguous and found in bank notes', () => {
    const codes = new Set(Array.from({ length: 2000 }, () => newOrderCode()));
    assert.equal(codes.size, 2000);
    for (const code of codes) assert.ok(isOrderCode(code), code);
    assert.equal(findOrderCode('MBVCB.1234.shabcd2345.CT tu 0123 NGUYEN VAN A'), 'SHABCD2345');
    assert.equal(findOrderCode('Thanh toan SH ABCD 2345'), 'SHABCD2345');
    assert.equal(findOrderCode('chuyen tien an trua'), null);
    assert.equal(findOrderCode('SHABCD0123'), null); // 0 and 1 are never used
});
