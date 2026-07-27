import { DeviceRuntime } from './device-runtime';
import type { FastifyBaseLogger } from 'fastify';
import type { DeviceState } from '../generation/telemetry-generator';

export class RuntimeManager {
    private devices: Map<string, DeviceRuntime> = new Map();
    private logger: FastifyBaseLogger;

    constructor(logger: FastifyBaseLogger) {
        this.logger = logger.child({ module: 'RuntimeManager' });
    }

    addDevice(
        mac: string,
        productId: string,
        intervalMs: number,
        initialSeq: number,
        initialState?: DeviceState,
    ): DeviceRuntime {
        if (this.devices.has(mac)) {
            return this.devices.get(mac) as DeviceRuntime;
        }
        const device = new DeviceRuntime(
            mac,
            productId,
            intervalMs,
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

    pauseDevice(mac: string) {
        const device = this.devices.get(mac);
        if (device) {
            device.pause();
        }
    }

    resumeDevice(mac: string) {
        const device = this.devices.get(mac);
        if (device) {
            device.resume();
        }
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
