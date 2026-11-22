const test = require('node:test');
const assert = require('node:assert/strict');
const { getPrometheusMetrics, getProcessMetrics } = require('../src/monitoring/metrics');

test('worker metrics include process CPU, memory and event loop lag without name clashes', async () => {
    const own = getPrometheusMetrics(null, null);
    const process = await getProcessMetrics();
    assert.match(process, /process_cpu_seconds_total\{service="mqtt-worker-service"\}/);
    assert.match(process, /nodejs_eventloop_lag_p99_seconds/);
    const names = (text) => new Set(text.split('\n').filter(line => line.startsWith('# TYPE ')).map(line => line.split(' ')[2]));
    for (const name of names(own)) assert.ok(!names(process).has(name), `${name} is defined twice`);
});
