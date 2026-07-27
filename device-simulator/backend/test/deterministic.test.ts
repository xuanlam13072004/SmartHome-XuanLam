import assert from 'node:assert/strict';
import test from 'node:test';
import {
    deterministicHex,
    deterministicInteger,
    deterministicMac,
    deterministicUnit,
} from '../src/generation/deterministic';

test('deterministic helpers reproduce values for the same seed and scope', () => {
    assert.equal(deterministicUnit('seed', 'scope'), deterministicUnit('seed', 'scope'));
    assert.equal(deterministicHex('seed', 'scope', 8), deterministicHex('seed', 'scope', 8));
    assert.equal(deterministicMac('seed', 'device:1'), deterministicMac('seed', 'device:1'));
});

test('deterministicInteger stays inside the inclusive range', () => {
    for (let index = 0; index < 100; index += 1) {
        const value = deterministicInteger('seed', `sample:${index}`, 2, 5);
        assert.ok(value >= 2 && value <= 5);
    }
});

test('deterministicMac creates an uppercase locally administered unicast address', () => {
    const mac = deterministicMac('seed', 'device:1');
    assert.match(mac, /^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/);
    const firstByte = Number.parseInt(mac.slice(0, 2), 16);
    assert.equal(firstByte & 0x01, 0);
    assert.equal(firstByte & 0x02, 0x02);
});

test('deterministicInteger rejects an inverted range', () => {
    assert.throws(
        () => deterministicInteger('seed', 'scope', 3, 2),
        /Invalid deterministic integer range/,
    );
});
