import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProductCatalog } from '../src/catalog/loader';
import { DeviceRuntime } from '../src/runtime/device-runtime';

const { compileCatalog, loadCatalogV2 } = require('../../../shared/catalog-v2');
const roof = compileCatalog(loadCatalogV2()).product_index.prod_roof_controller as ProductCatalog;
const logger = { child: () => logger, debug() {}, info() {}, warn() {}, error() {} } as any;

const runtimeWith = (transport: Record<string, unknown>) => new DeviceRuntime(
    'run', 'AA:00:00:00:00:21', roof, 30000, 0, 0, 0, logger,
    { isRelayAvailable: () => false, onBrokerUnavailable() {}, onBrokerAvailable() {}, ...transport } as any,
);

test('a refused login re-registers the stored identity once and connects', async () => {
    let repaired = 0;
    const runtime = runtimeWith({
        resolveBrokerCredentials: async () => ({ username: 'AA:00:00:00:00:21', password: 'stored' }),
        repairBrokerIdentity: async () => { repaired += 1; return { username: 'AA:00:00:00:00:21', password: 'stored' }; },
    });
    let attempts = 0;
    (runtime as any).openBrokerConnection = async () => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error('Connection refused: Not authorized'), { code: 5 });
    };
    await (runtime as any).ensureBrokerConnection();
    assert.equal(attempts, 2);
    assert.equal(repaired, 1);
});

test('network errors are not mistaken for a lost identity', async () => {
    let repaired = 0;
    const runtime = runtimeWith({
        resolveBrokerCredentials: async () => ({ username: 'AA:00:00:00:00:21', password: 'stored' }),
        repairBrokerIdentity: async () => { repaired += 1; return { username: 'x', password: 'y' }; },
    });
    (runtime as any).openBrokerConnection = async () => {
        throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    };
    await assert.rejects((runtime as any).ensureBrokerConnection(), /ECONNREFUSED/);
    assert.equal(repaired, 0);
});
