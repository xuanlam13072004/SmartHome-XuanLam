import { DeviceRuntime } from './device-runtime';
import type { FastifyBaseLogger } from 'fastify';
import type { DeviceState } from '../generation/telemetry-generator';
import { env } from '../config/env';
import type { RuntimeMetricStats } from '../metrics/service';
import { getTelemetryScheduler } from './telemetry-scheduler';

export class RuntimeManager {
    private devices: Map<string, DeviceRuntime> = new Map();
    private logger: FastifyBaseLogger;

    constructor(logger: FastifyBaseLogger) {
        this.logger = logger.child({ module: 'RuntimeManager' });
    }

    addDevice(
        runId: string,
        mac: string,
        productId: string,
        intervalMs: number,
        telemetryJitterPercent: number,
        startupRampSeconds: number,
        initialSeq: number,
        initialState?: DeviceState,
    ): DeviceRuntime {
        if (this.devices.has(mac)) {
            return this.devices.get(mac) as DeviceRuntime;
        }
        if (this.devices.size >= env.MAX_ACTIVE_DEVICES) {
            throw new Error(
                `Active virtual device limit reached (${env.MAX_ACTIVE_DEVICES})`,
            );
        }
        const device = new DeviceRuntime(
            runId,
            mac,
            productId,
            intervalMs,
            telemetryJitterPercent,
            startupRampSeconds * 1000,
            initialSeq,
            this.logger,
            initialState,
        );
        this.devices.set(mac, device);
        return device;
    }

    getDevice(mac: string): DeviceRuntime | undefined {
        return this.devices.get(mac);
    }

    async connectDevice(mac: string): Promise<void> {
        const device = this.devices.get(mac);
        if (device) {
            await device.connect();
        }
    }

    async disconnectDevice(mac: string): Promise<void> {
        const device = this.devices.get(mac);
        if (device) {
            await device.disconnect();
        }
    }

    async removeDevice(mac: string): Promise<void> {
        const device = this.devices.get(mac);
        if (device) await device.disconnect();
        this.devices.delete(mac);
    }

    async stopRun(runId: string): Promise<number> {
        const devices = [...this.devices.entries()].filter(
            ([, device]) => device.runId === runId,
        );
        await Promise.all(devices.map(([, device]) => device.disconnect()));
        for (const [mac] of devices) this.devices.delete(mac);
        return devices.length;
    }

    async pauseDevice(mac: string): Promise<void> {
        const device = this.devices.get(mac);
        if (device) {
            await device.pause();
        }
    }

    async resumeDevice(mac: string): Promise<void> {
        const device = this.devices.get(mac);
        if (device) {
            await device.resume();
        }
    }

    async pauseRun(runId: string): Promise<void> {
        await Promise.all(
            [...this.devices.values()]
                .filter((device) => device.runId === runId)
                .map((device) => device.pause()),
        );
    }

    getStats(runId: string): RuntimeMetricStats {
        const devices = [...this.devices.values()].filter(
            (device) => device.runId === runId,
        );
        const scheduler = getTelemetryScheduler().getStats(runId);
        return {
            registered: devices.length,
            connected: devices.filter((device) => device.connected).length,
            paused: devices.filter((device) => device.paused).length,
            scheduler_active: scheduler.active,
            scheduler_due: scheduler.due,
        };
    }

    async disconnectAll(): Promise<void> {
        await Promise.all([...this.devices.values()].map((device) => device.disconnect()));
        this.devices.clear();
    }
}

// Singleton instance for the app
let managerInstance: RuntimeManager | null = null;
export const getRuntimeManager = (logger: FastifyBaseLogger): RuntimeManager => {
    if (!managerInstance) {
        managerInstance = new RuntimeManager(logger);
    }
    return managerInstance;
};
