import http from 'http';
import client from 'prom-client';

/**
 * Prometheus metrics of the realtime service (docs/architecture/load-testing.md),
 * served on METRICS_PORT inside the Docker network only.
 */

export const registry = new client.Registry();
registry.setDefaultLabels({ service: 'real-time-service' });
client.collectDefaultMetrics({ register: registry });

export const messagesSent = new client.Counter({
    name: 'smarthome_realtime_messages_total',
    help: 'Messages sent to connected apps, by event',
    labelNames: ['event'] as const,
    registers: [registry],
});

/** Connected sockets and accounts, read when Prometheus scrapes. */
export function trackConnections(read: () => { sockets: number; accounts: number }): void {
    new client.Gauge({
        name: 'smarthome_realtime_connections',
        help: 'Open WebSocket connections',
        registers: [registry],
        collect() {
            this.set(read().sockets);
        },
    });
    new client.Gauge({
        name: 'smarthome_realtime_accounts',
        help: 'Accounts with at least one open connection',
        registers: [registry],
        collect() {
            this.set(read().accounts);
        },
    });
}

/** Event names are a small fixed set; anything odd is grouped. */
export function eventLabel(event: unknown): string {
    return typeof event === 'string' && /^[a-z_]{1,40}$/.test(event) ? event : 'other';
}

export function startMetricsServer(port: number): http.Server | null {
    if (!port) return null;
    const server = http.createServer(async (request, response) => {
        if (request.url !== '/metrics') {
            response.writeHead(404).end();
            return;
        }
        response.writeHead(200, { 'Content-Type': registry.contentType });
        response.end(await registry.metrics());
    });
    server.listen(port, '0.0.0.0', () => console.log(`📈 Metrics server listening on ${port}`));
    server.unref();
    return server;
}
