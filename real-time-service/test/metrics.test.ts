import './setup-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { eventLabel, messagesSent, registry, trackConnections } from '../src/services/metrics.js';

test('realtime metrics: connections are read at scrape time, event names are bounded', async () => {
    let sockets = 3;
    trackConnections(() => ({ sockets, accounts: 2 }));
    messagesSent.inc({ event: eventLabel('telemetry') }, 2);
    messagesSent.inc({ event: eventLabel('<script>') });
    sockets = 5;
    const text = await registry.metrics();
    assert.match(text, /smarthome_realtime_connections\{service="real-time-service"\} 5/);
    assert.match(text, /smarthome_realtime_accounts\{service="real-time-service"\} 2/);
    assert.match(text, /smarthome_realtime_messages_total\{event="telemetry",service="real-time-service"\} 2/);
    assert.match(text, /event="other",service="real-time-service"\} 1/);
    assert.match(text, /process_resident_memory_bytes/);
});
