import assert from 'node:assert/strict';
import test from 'node:test';
import { measureIngestLatency } from '../src/api/routes/overview';

test('ingest latency is measured from the device clock to the backend write', () => {
    const at = (ms: number) => new Date(1_000_000 + ms);
    const rows = Array.from({ length: 100 }, (_, index) => ({ observed_at: at(0), ingested_at: at(index + 1) }));
    rows.push({ observed_at: at(0), ingested_at: undefined as any });
    assert.deepEqual(measureIngestLatency(rows), { samples: 100, p50_ms: 51, p95_ms: 96, max_ms: 100 });
    assert.equal(measureIngestLatency([]), null);
});
