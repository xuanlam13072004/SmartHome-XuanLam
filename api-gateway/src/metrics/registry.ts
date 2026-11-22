import http from 'node:http';
import client from 'prom-client';

/**
 * Prometheus metrics of the Gateway (docs/architecture/load-testing.md). They
 * are served on a separate port inside the Docker network (METRICS_PORT), never
 * through the public API or the tunnel.
 */

export const registry = new client.Registry();
registry.setDefaultLabels({ service: 'api-gateway' });
// CPU, memory, event loop lag, garbage collection, handles.
client.collectDefaultMetrics({ register: registry });

export const httpDuration = new client.Histogram({
    name: 'smarthome_http_request_duration_seconds',
    help: 'API requests by route template, method and status code',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
});

export const operationDuration = new client.Histogram({
    name: 'smarthome_device_operation_duration_seconds',
    help: 'From a command accepted by the API to the device result (succeeded, failed, rejected, timed_out…)',
    labelNames: ['result'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60],
    registers: [registry],
});

export const pushSent = new client.Counter({
    name: 'smarthome_push_notifications_total',
    help: 'Push notifications by result (sent, invalid_token, failed)',
    labelNames: ['result'] as const,
    registers: [registry],
});

export const assistantTurns = new client.Counter({
    name: 'smarthome_assistant_turns_total',
    help: 'Assistant turns by channel and outcome',
    labelNames: ['channel', 'outcome'] as const,
    registers: [registry],
});

/** Serves /metrics on [port] (0 = off). */
export function startMetricsServer(port: number, log: { info: (obj: object, msg: string) => void }): http.Server | null {
    if (!port) return null;
    const server = http.createServer(async (request, response) => {
        if (request.url !== '/metrics') {
            response.writeHead(404).end();
            return;
        }
        response.writeHead(200, { 'content-type': registry.contentType });
        response.end(await registry.metrics());
    });
    server.listen(port, '0.0.0.0', () => log.info({ port }, 'Metrics server listening'));
    server.unref();
    return server;
}
