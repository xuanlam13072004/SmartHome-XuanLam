import type { FastifyBaseLogger } from 'fastify';
import type { MqttClient } from 'mqtt';
import { env } from '../config/env';
import type { DeviceState } from '../generation/telemetry-generator';
import {
    createDeviceMqttClient,
    resolveMqttTopic,
} from '../infrastructure/mqtt/client';
import { getMongoDb } from '../infrastructure/mongodb/client';
import type { RuntimeMetricStats } from '../metrics/service';
import {
    type BrokerMessageKind,
    DeviceRuntime,
    type RuntimeTransportCoordinator,
} from './device-runtime';
import { getTelemetryScheduler } from './telemetry-scheduler';
import {
    parseTopologyAssignment,
    shouldApplyAssignment,
    transportEnvelopeFor,
    type CommandRoute,
    type TopologyAssignment,
} from './topology';

const normalizeMac = (value: string): string => value.trim().toUpperCase();

const extractDeviceId = (topic: string): string => {
    const [prefix, suffix] = env.MQTT_TOPOLOGY_TOPIC.split('{device_id}');
    if (
        suffix === undefined
        || !topic.startsWith(prefix)
        || !topic.endsWith(suffix)
    ) {
        return '';
    }
    return normalizeMac(topic.slice(prefix.length, topic.length - suffix.length));
};

export class RuntimeManager implements RuntimeTransportCoordinator {
    private readonly devices = new Map<string, DeviceRuntime>();
    private readonly assignments = new Map<string, TopologyAssignment>();
    private readonly assignmentTasks = new Map<string, Promise<void>>();
    private readonly stoppingRuns = new Set<string>();
    private logger: FastifyBaseLogger;
    private topologyClient: MqttClient | null = null;
    private startPromise: Promise<void> | null = null;
    private shuttingDown = false;

    constructor(logger: FastifyBaseLogger) {
        this.logger = logger.child({ module: 'RuntimeManager' });
    }

    async start(): Promise<void> {
        if (this.topologyClient?.connected) return;
        if (this.startPromise) return this.startPromise;
        this.shuttingDown = false;
        this.startPromise = new Promise<void>((resolve, reject) => {
            const clientId = `device-simulator-topology-${process.pid}`;
            const client = createDeviceMqttClient(clientId);
            this.topologyClient = client;

            const onInitialError = (error: Error) => {
                client.off('connect', onInitialConnect);
                client.end(true);
                if (this.topologyClient === client) this.topologyClient = null;
                this.startPromise = null;
                reject(error);
            };
            const onInitialConnect = () => {
                client.off('error', onInitialError);
                this.startPromise = null;
                resolve();
            };
            client.once('error', onInitialError);
            client.once('connect', onInitialConnect);

            client.on('connect', () => {
                const wildcard = resolveMqttTopic(env.MQTT_TOPOLOGY_TOPIC, '+');
                client.subscribe(wildcard, { qos: 1 }, (error) => {
                    if (error) {
                        this.logger.error(
                            { err: error, topic: wildcard },
                            'Failed to subscribe to topology assignments',
                        );
                    } else {
                        this.logger.info(
                            { topic: wildcard },
                            'Simulator topology control plane connected',
                        );
                    }
                });
            });
            client.on('message', (topic, payload) => {
                void this.handleTopologyMessage(topic, payload);
            });
            client.on('error', (error) => {
                this.logger.error({ err: error }, 'Simulator topology control plane MQTT error');
            });
        });
        return this.startPromise;
    }

    addDevice(
        runId: string,
        macInput: string,
        productId: string,
        intervalMs: number,
        telemetryJitterPercent: number,
        startupRampSeconds: number,
        initialSeq: number,
        initialState?: DeviceState,
        initialAssignment?: TopologyAssignment,
    ): DeviceRuntime {
        const mac = normalizeMac(macInput);
        if (this.devices.has(mac)) {
            const existing = this.devices.get(mac) as DeviceRuntime;
            if (initialAssignment) void this.queueAssignment(mac, initialAssignment);
            return existing;
        }
        if (this.devices.size >= env.MAX_ACTIVE_DEVICES) {
            throw new Error(
                `Active virtual device limit reached (${env.MAX_ACTIVE_DEVICES})`,
            );
        }
        const cachedAssignment = this.assignments.get(mac);
        const assignment = cachedAssignment && initialAssignment
            ? (
                shouldApplyAssignment(initialAssignment, cachedAssignment)
                    ? cachedAssignment
                    : initialAssignment
            )
            : cachedAssignment || initialAssignment;
        if (assignment) this.assignments.set(mac, assignment);

        const device = new DeviceRuntime(
            runId,
            mac,
            productId,
            intervalMs,
            telemetryJitterPercent,
            startupRampSeconds * 1000,
            initialSeq,
            this.logger,
            this,
            initialState,
            assignment,
        );
        this.devices.set(mac, device);
        return device;
    }

    getDevice(mac: string): DeviceRuntime | undefined {
        return this.devices.get(normalizeMac(mac));
    }

    async connectDevice(mac: string): Promise<void> {
        const device = this.getDevice(mac);
        if (device) await device.connect();
    }

    async disconnectDevice(mac: string): Promise<void> {
        const device = this.getDevice(mac);
        if (device) await device.disconnect();
    }

    async removeDevice(macInput: string): Promise<void> {
        const mac = normalizeMac(macInput);
        const device = this.devices.get(mac);
        if (device) await device.disconnect();
        this.devices.delete(mac);
    }

    async stopRun(runId: string): Promise<number> {
        this.stoppingRuns.add(runId);
        const devices = [...this.devices.entries()].filter(
            ([, device]) => device.runId === runId,
        );
        await Promise.allSettled(devices.map(([, device]) => device.disconnect()));
        for (const [mac] of devices) this.devices.delete(mac);
        this.stoppingRuns.delete(runId);
        return devices.length;
    }

    async pauseDevice(mac: string): Promise<void> {
        const device = this.getDevice(mac);
        if (device) await device.pause();
    }

    async resumeDevice(mac: string): Promise<void> {
        const device = this.getDevice(mac);
        if (device) await device.resume();
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
            broker_connected: devices.filter((device) => device.brokerConnected).length,
            relay_connected: devices.filter(
                (device) => device.connected && device.effectiveTransportMode === 'relay',
            ).length,
            direct_fallback_connected: devices.filter(
                (device) => (
                    device.connected
                    && device.effectiveTransportMode === 'direct_fallback'
                ),
            ).length,
            paused: devices.filter((device) => device.paused).length,
            scheduler_active: scheduler.active,
            scheduler_due: scheduler.due,
        };
    }

    isRelayAvailable(device: DeviceRuntime): boolean {
        const topology = device.topology;
        if (!topology?.active_hub_mac) return false;
        const hub = this.devices.get(topology.active_hub_mac);
        return Boolean(
            hub
            && hub.runId === device.runId
            && hub.brokerConnected
            && hub.topology?.network_id === topology.network_id
            && hub.topology?.topology_epoch === topology.topology_epoch
            && hub.topology?.role === 'hub',
        );
    }

    async publishDeviceMessage(
        device: DeviceRuntime,
        kind: BrokerMessageKind,
        payload: Record<string, unknown>,
        commandRoute?: CommandRoute,
    ): Promise<void> {
        const topology = device.topology;
        const effectiveMode = device.effectiveTransportMode;
        if (!topology || effectiveMode === 'direct') {
            await device.publishBrokerMessage(kind, payload);
            return;
        }
        if (commandRoute?.mode === 'direct') {
            await device.publishBrokerMessage(kind, payload);
            return;
        }

        const routeMode = commandRoute?.mode || effectiveMode;
        const envelope = commandRoute
            ? {
                mode: commandRoute.mode,
                network_id: commandRoute.network_id,
                topology_epoch: commandRoute.topology_epoch,
                hub_mac: commandRoute.hub_mac,
            }
            : transportEnvelopeFor(topology, routeMode);
        const routedPayload = {
            ...payload,
            transport: envelope,
        };

        if (routeMode === 'relay') {
            const hubMac = normalizeMac(String(commandRoute?.hub_mac || topology.active_hub_mac || ''));
            const hub = this.devices.get(hubMac);
            if (!hub?.brokerConnected) {
                await device.activateDirectFallback();
                if (kind === 'ack' && commandRoute?.mode === 'relay') {
                    throw new Error('The command route Hub became unavailable before ACK');
                }
                await device.publishBrokerMessage(kind, {
                    ...payload,
                    transport: transportEnvelopeFor(topology, 'direct_fallback'),
                });
                return;
            }
            await hub.publishBrokerMessage(kind, routedPayload);
            return;
        }

        await device.publishBrokerMessage(kind, routedPayload);
    }

    async deliverRelayedCommand(hubMacInput: string, rawPayload: Buffer): Promise<void> {
        const hubMac = normalizeMac(hubMacInput);
        let parsed: unknown;
        try {
            parsed = JSON.parse(rawPayload.toString());
        } catch {
            throw new Error('Hub received a command that is not valid JSON');
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Hub received an invalid relayed command');
        }
        const target = normalizeMac(String(
            (parsed as Record<string, unknown>).target_device_id || '',
        ));
        const node = this.devices.get(target);
        if (!target || !node) {
            throw new Error(`Hub cannot reach simulated Node ${target || '<missing>'}`);
        }
        const hub = this.devices.get(hubMac);
        if (
            !hub
            || !node.connected
            || hub.topology?.role !== 'hub'
            || node.topology?.active_hub_mac !== hubMac
            || node.topology?.network_id !== hub.topology.network_id
            || node.topology?.topology_epoch !== hub.topology.topology_epoch
        ) {
            throw new Error('Hub and Node do not share the current topology assignment');
        }
        await node.receiveCommand(rawPayload, hubMac);
    }

    onBrokerUnavailable(device: DeviceRuntime): void {
        if (
            this.shuttingDown
            || this.stoppingRuns.has(device.runId)
            || device.topology?.role !== 'hub'
        ) {
            return;
        }
        const networkId = device.topology.network_id;
        for (const node of this.devices.values()) {
            if (
                node.runId === device.runId
                && node.topology?.network_id === networkId
                && node.topology.role === 'node'
            ) {
                void node.activateDirectFallback().catch((error) => {
                    this.logger.error(
                        { err: error, mac: node.id, networkId },
                        'Failed to activate Node direct fallback',
                    );
                });
            }
        }
    }

    onBrokerAvailable(device: DeviceRuntime): void {
        if (device.topology?.role !== 'hub') return;
        this.refreshNetwork(device.topology.network_id, device.runId);
    }

    async disconnectAll(): Promise<void> {
        this.shuttingDown = true;
        await Promise.allSettled(
            [...this.devices.values()].map((device) => device.disconnect()),
        );
        this.devices.clear();
        const client = this.topologyClient;
        this.topologyClient = null;
        this.startPromise = null;
        if (client) {
            await new Promise<void>((resolve) => {
                client.end(false, {}, () => resolve());
            });
        }
    }

    private async handleTopologyMessage(topic: string, payload: Buffer): Promise<void> {
        const mac = extractDeviceId(topic);
        if (!mac) return;
        if (payload.length === 0) {
            this.assignments.delete(mac);
            await getMongoDb().collection('simulated_devices').updateOne(
                { mac },
                {
                    $set: {
                        topology_state: 'empty',
                        transport_mode: 'offline',
                        active_hub_mac: null,
                        updated_at: new Date(),
                    },
                    $unset: {
                        network_id: '',
                        topology_role: '',
                        topology_epoch: '',
                        join_rank: '',
                    },
                },
            );
            return;
        }
        try {
            const assignment = parseTopologyAssignment(JSON.parse(payload.toString()));
            const current = this.assignments.get(mac);
            if (!shouldApplyAssignment(current, assignment)) return;
            this.assignments.set(mac, assignment);
            await getMongoDb().collection('simulated_devices').updateOne(
                { mac },
                {
                    $set: {
                        network_id: assignment.network_id,
                        join_rank: assignment.join_rank,
                        topology_role: assignment.role,
                        topology_epoch: assignment.topology_epoch,
                        topology_state: assignment.topology_state,
                        active_hub_mac: assignment.active_hub_mac,
                        transport_mode: assignment.transport_mode,
                        updated_at: new Date(),
                    },
                },
            );
            await this.queueAssignment(mac, assignment);
        } catch (error) {
            this.logger.warn(
                { err: error, topic },
                'Rejected invalid or stale topology assignment',
            );
        }
    }

    private queueAssignment(mac: string, assignment: TopologyAssignment): Promise<void> {
        const previous = this.assignmentTasks.get(mac) || Promise.resolve();
        const next = previous
            .catch(() => undefined)
            .then(async () => {
                const device = this.devices.get(mac);
                if (device) {
                    await device.applyTopologyAssignment(assignment);
                    this.refreshNetwork(assignment.network_id, device.runId);
                }
            })
            .finally(() => {
                if (this.assignmentTasks.get(mac) === next) {
                    this.assignmentTasks.delete(mac);
                }
            });
        this.assignmentTasks.set(mac, next);
        return next;
    }

    private refreshNetwork(networkId: string, runId: string): void {
        for (const device of this.devices.values()) {
            if (
                device.runId === runId
                && device.topology?.network_id === networkId
            ) {
                void device.refreshTransportAvailability().catch((error) => {
                    this.logger.error(
                        { err: error, mac: device.id, networkId },
                        'Failed to refresh virtual device network transport',
                    );
                });
            }
        }
    }
}

let managerInstance: RuntimeManager | null = null;
export const getRuntimeManager = (logger: FastifyBaseLogger): RuntimeManager => {
    if (!managerInstance) managerInstance = new RuntimeManager(logger);
    return managerInstance;
};
