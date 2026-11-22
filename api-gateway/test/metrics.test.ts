import './setup-env';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fastify from 'fastify';
import metricsPlugin from '../src/plugins/metrics';
import { operationDuration, registry, startMetricsServer } from '../src/metrics/registry';

test('requests are timed by route template; metrics are served on their own port', async () => {
    const app = fastify({ logger: false });
    await app.register(metricsPlugin);
    app.get('/devices/:mac', async () => ({ ok: true }));
    await app.ready();
    await app.inject({ method: 'GET', url: '/devices/AA:BB:CC:DD:EE:01' });
    await app.inject({ method: 'GET', url: '/nowhere' });
    operationDuration.observe({ result: 'succeeded' }, 0.42);

    const server = startMetricsServer(0, { info: () => undefined });
    assert.equal(server, null, 'port 0 turns it off');
    const served = startMetricsServer(39101, { info: () => undefined })!;
    try {
        await new Promise(resolve => served.once('listening', resolve));
        const port = (served.address() as AddressInfo).port;
        const text = await new Promise<string>((resolve, reject) => {
            http.get(`http://127.0.0.1:${port}/metrics`, response => {
                let body = '';
                response.on('data', chunk => { body += chunk; });
                response.on('end', () => resolve(body));
            }).on('error', reject);
        });
        const line = (...parts: string[]) => text.split('\n').find(row => parts.every(part => row.includes(part)));
        assert.match(line('smarthome_http_request_duration_seconds_count{', 'route="/devices/:mac"', 'status="200"', 'service="api-gateway"') ?? '', / 1$/);
        assert.ok(line('smarthome_http_request_duration_seconds_count{', 'route="unmatched"', 'status="404"'));
        assert.doesNotMatch(text, /AA:BB:CC/, 'raw URLs never become labels');
        assert.match(line('smarthome_device_operation_duration_seconds_bucket{', 'le="0.5"', 'result="succeeded"') ?? '', / 1$/);
        assert.match(text, /process_cpu_seconds_total/);
        assert.match(text, /nodejs_eventloop_lag_p99_seconds/);
    } finally {
        await new Promise(resolve => served.close(resolve));
        await app.close();
    }
    assert.ok((await registry.getMetricsAsJSON()).length > 10);
});
