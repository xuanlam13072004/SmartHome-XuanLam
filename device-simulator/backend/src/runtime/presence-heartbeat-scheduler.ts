import { env } from '../config/env';
import { TelemetryScheduler } from './telemetry-scheduler';

// Must stay comfortably below mqtt-worker-service's 25-second online lease.
export const PRESENCE_HEARTBEAT_INTERVAL_MS = 10_000;

const scheduler = new TelemetryScheduler(env.TELEMETRY_PUBLISH_CONCURRENCY);

export const registerPresenceHeartbeat = (
    deviceId: string,
    runId: string,
    publish: () => Promise<void>,
): void => {
    scheduler.register({
        deviceId,
        runId,
        intervalMs: PRESENCE_HEARTBEAT_INTERVAL_MS,
        jitterPercent: 0,
        initialDelayMs: PRESENCE_HEARTBEAT_INTERVAL_MS,
        publish,
    });
};

export const unregisterPresenceHeartbeat = (deviceId: string): void => {
    scheduler.unregister(deviceId);
};

export const stopPresenceHeartbeatScheduler = (): void => {
    scheduler.stop();
};
