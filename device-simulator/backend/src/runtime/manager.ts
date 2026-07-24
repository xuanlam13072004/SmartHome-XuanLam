import { DeviceRuntime } from './device-runtime';
import pino from 'pino';

export class RuntimeManager {
    private devices: Map<string, DeviceRuntime> = new Map();
    private logger: pino.Logger;

    constructor(logger: pino.Logger) {
        this.logger = logger.child({ module: 'RuntimeManager' });
    }

    addDevice(mac: string, productId: string, intervalMs: number, initialSeq: number) {
        if (this.devices.has(mac)) {
            return this.devices.get(mac);
        }
        const device = new DeviceRuntime(mac, productId, intervalMs, initialSeq, this.logger);
        this.devices.set(mac, device);
        return device;
    }

    getDevice(mac: string): DeviceRuntime | undefined {
        return this.devices.get(mac);
    }

    async connectDevice(mac: string) {
        const device = this.devices.get(mac);
        if (device) {
            await device.connect();
        }
    }

    disconnectDevice(mac: string) {
        const device = this.devices.get(mac);
        if (device) {
            device.disconnect();
        }
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

    disconnectAll() {
        for (const device of this.devices.values()) {
            device.disconnect();
        }
        this.devices.clear();
    }
}

// Singleton instance for the app
let managerInstance: RuntimeManager | null = null;
export const getRuntimeManager = (logger: pino.Logger): RuntimeManager => {
    if (!managerInstance) {
        managerInstance = new RuntimeManager(logger);
    }
    return managerInstance;
};
