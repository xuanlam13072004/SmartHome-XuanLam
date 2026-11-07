import type { FastifyBaseLogger } from 'fastify';
import type { ProductCatalog } from '../catalog/loader';
import { env } from '../config/env';
import type { DeviceState } from '../generation/telemetry-generator';
import type { EncryptedValue, SimulatedDeviceRecord } from '../domain/registry';
import {
    type BrokerIdentityRegistry,
    generateDeviceMqttPassword,
    getBrokerIdentityRegistry,
} from '../infrastructure/mqtt/broker-identity';
import { probeMqtt, type BrokerCredentials } from '../infrastructure/mqtt/client';
import { getMongoDb } from '../infrastructure/mongodb/client';
import { decrypt, encrypt } from '../security/crypto';
import type { RuntimeMetricStats } from '../metrics/service';
import {
    type BrokerMessageKind,
    DeviceRuntime,
    type RuntimeTransportCoordinator,
} from './device-runtime';
import { getTelemetryScheduler } from './telemetry-scheduler';
import { getMediaStore } from '../media';
import type { IrrigationSession } from './irrigation-controller';
import {
    parseTopologyAssignment,
    shouldApplyAssignment,
    transportEnvelopeFor,
    type OperationRoute,
    type TopologyAssignment,
} from './topology';

const normalizeMac = (value: string): string => value.trim().toUpperCase();

const decryptSecret = (value: EncryptedValue): string => decrypt(value.iv, value.encrypted, value.authTag);

/** Same derivation MQTT Worker uses when it publishes per-member assignments. */
export const deriveMemberAssignment = (
    hubAssignment: TopologyAssignment,
    member: TopologyAssignment['members'][number],
): TopologyAssignment => ({
    ...hubAssignment,
    role: member.role,
    join_rank: Number(member.join_rank),
    transport_mode: member.role === 'hub'
        ? 'hub'
        : (hubAssignment.topology_state === 'stable' ? 'relay' : 'direct_fallback'),
});


export class RuntimeManager implements RuntimeTransportCoordinator {
    private readonly devices = new Map<string, DeviceRuntime>();
    private readonly assignments = new Map<string, TopologyAssignment>();
    private readonly assignmentTasks = new Map<string, Promise<void>>();
    private readonly stoppingRuns = new Set<string>();
    private logger: FastifyBaseLogger;
    private readonly brokerCredentials = new Map<string, Promise<BrokerCredentials>>();
    private shuttingDown = false;

    constructor(
        logger: FastifyBaseLogger,
        private readonly registryDb = getMongoDb,
        private readonly brokerIdentities: () => Pick<
            BrokerIdentityRegistry,
            'ensureDeviceIdentity' | 'revokeDeviceIdentity'
        > = getBrokerIdentityRegistry,
    ) {
        this.logger = logger.child({ module: 'RuntimeManager' });
    }

    /**
     * Verifies that the broker accepts the factory identity. Virtual devices
     * then connect with their own credentials and subscribe only to their own
     * topics, exactly like physical devices; there is no shared wildcard
     * subscription (docs/architecture/mqtt-security.md).
     */
    async start(): Promise<void> {
        this.shuttingDown = false;
        await probeMqtt();
    }

    /**
     * Returns the device's factory-issued broker credentials, creating them on
     * first use (devices provisioned before broker authentication existed are
     * "re-flashed" here). The identity is (re)registered once per process so a
     * reset broker database heals itself.
     */
    resolveBrokerCredentials(macInput: string): Promise<BrokerCredentials> {
        const mac = normalizeMac(macInput);
        const cached = this.brokerCredentials.get(mac);
        if (cached) return cached;
        const resolved = (async () => {
            const devices = this.registryDb().collection<SimulatedDeviceRecord>('simulated_devices');
            const record = await devices.findOne({ mac }, { projection: { mqtt_secret: 1 } });
            let password: string;
            if (record?.mqtt_secret) {
                password = decryptSecret(record.mqtt_secret);
            } else {
                password = generateDeviceMqttPassword();
                await devices.updateOne({ mac }, { $set: { mqtt_secret: encrypt(password) } });
            }
            await this.brokerIdentities().ensureDeviceIdentity(mac, password);
            return { username: mac, password };
        })();
        this.brokerCredentials.set(mac, resolved);
        resolved.catch(() => {
            if (this.brokerCredentials.get(mac) === resolved) this.brokerCredentials.delete(mac);
        });
        return resolved;
    }

    /** Factory retirement: the broker deletes the identity and drops its session. */
    async revokeBrokerIdentity(macInput: string): Promise<void> {
        const mac = normalizeMac(macInput);
        this.brokerCredentials.delete(mac);
        await this.brokerIdentities().revokeDeviceIdentity(mac);
    }

    addDevice(
        runId: string,
        macInput: string,
        product: ProductCatalog,
        intervalMs: number,
        telemetryJitterPercent: number,
        startupRampSeconds: number,
        initialSeq: number,
        initialState?: DeviceState,
        initialAssignment?: TopologyAssignment,
        accessPin?: string,
        irrigationSession?: IrrigationSession,
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
            product,
            intervalMs,
            telemetryJitterPercent,
            startupRampSeconds * 1000,
            initialSeq,
            this.logger,
            this,
            initialState,
            assignment,
            accessPin,
            irrigationSession,
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
        if (device) await device.dispose();
        this.devices.delete(mac);
    }

    async revokeDeviceOwnership(macInput: string): Promise<void> {
        const mac = normalizeMac(macInput);
        this.assignments.delete(mac);
        await this.assignmentTasks.get(mac)?.catch(() => undefined);
        const runId = this.devices.get(mac)?.runId ?? await this.registryRunId(mac);
        await this.removeDevice(mac);
        // Owner boundary (camera contract 7.5): an unpaired camera keeps no recordings.
        if (runId) {
            await getMediaStore().wipeCamera(runId, mac).catch((error) => this.logger.warn(
                { err: error, mac },
                'Failed to wipe recordings of an unpaired virtual camera',
            ));
        }
        await this.registryDb().collection('simulated_devices').updateOne(
            { mac },
            {
                $set: {
                    topology_state: 'empty', active_hub_mac: null,
                    provisioning_state: 'unpaired', runtime_state: 'offline',
                    desired_state: 'offline', updated_at: new Date(),
                },
                $unset: {
                    network_id: '', topology_role: '', topology_epoch: '', join_rank: '',
                    device_id: '', state_snapshot: '', irrigation_session: '',
                    pending_device_events: '', transport_mode: '',
                },
            },
        );
    }

    private async registryRunId(mac: string): Promise<string | undefined> {
        try {
            const record = await this.registryDb().collection<SimulatedDeviceRecord>('simulated_devices')
                .findOne({ mac }, { projection: { run_id: 1 } });
            return record?.run_id;
        } catch (error) {
            this.logger.warn({ err: error, mac }, 'Could not resolve the run of an unpaired device');
            return undefined;
        }
    }

    async stopRun(runId: string): Promise<number> {
        this.stoppingRuns.add(runId);
        const devices = [...this.devices.entries()].filter(
            ([, device]) => device.runId === runId,
        );
        await Promise.allSettled(devices.map(([, device]) => device.dispose()));
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
        operationRoute?: OperationRoute,
    ): Promise<void> {
        const topology = device.topology;
        const effectiveMode = device.effectiveTransportMode;
        if (!topology || effectiveMode === 'direct') {
            await device.publishBrokerMessage(kind, payload);
            return;
        }
        if (operationRoute?.mode === 'direct') {
            await device.publishBrokerMessage(kind, payload);
            return;
        }

        const routeMode = operationRoute?.mode || effectiveMode;
        const envelope = operationRoute
            ? {
                mode: operationRoute.mode,
                network_id: operationRoute.network_id,
                topology_epoch: operationRoute.topology_epoch,
                hub_mac: operationRoute.hub_mac,
            }
            : transportEnvelopeFor(topology, routeMode);
        const routedPayload = {
            ...payload,
            transport: envelope,
        };

        if (routeMode === 'relay') {
            const hubMac = normalizeMac(String(operationRoute?.hub_mac || topology.active_hub_mac || ''));
            const hub = this.devices.get(hubMac);
            if (!hub?.brokerConnected) {
                await device.activateDirectFallback();
                if (kind === 'operation_ack' && operationRoute?.mode === 'relay') {
                    throw new Error('The operation route Hub became unavailable before ACK');
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

    async deliverRelayedOperation(hubMacInput: string, rawPayload: Buffer): Promise<void> {
        const hubMac = normalizeMac(hubMacInput);
        let parsed: unknown;
        try {
            parsed = JSON.parse(rawPayload.toString());
        } catch {
            throw new Error('Hub received an operation that is not valid JSON');
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Hub received an invalid relayed operation');
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
        await node.receiveOperation(rawPayload, hubMac);
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
            [...this.devices.values()].map((device) => device.dispose()),
        );
        this.devices.clear();
    }

    /** Retained assignment received on the device's own `smarthome/<mac>/topology`. */
    async onTopologyMessage(macInput: string, payload: Buffer): Promise<void> {
        const mac = normalizeMac(macInput);
        if (payload.length === 0) {
            await this.revokeDeviceOwnership(mac);
            return;
        }
        try {
            const assignment = parseTopologyAssignment(JSON.parse(payload.toString()));
            await this.applyAssignment(mac, assignment);
            if (assignment.role === 'hub') await this.relayTopologyToNodes(mac, assignment);
        } catch (error) {
            this.logger.warn(
                { err: error, mac },
                'Rejected invalid or stale topology assignment',
            );
        }
    }

    private async applyAssignment(mac: string, assignment: TopologyAssignment): Promise<boolean> {
        const current = this.assignments.get(mac);
        if (!shouldApplyAssignment(current, assignment)) return false;
        this.assignments.set(mac, assignment);
        await this.registryDb().collection('simulated_devices').updateOne(
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
        return true;
    }

    /**
     * Simulated Hub radio: a relay Node has no broker connection, so the Hub
     * passes on the member list from its own assignment. Nodes connected to the
     * broker read their own retained assignment instead. A Node that disappears
     * from a newer epoch of its network was unpaired.
     */
    private async relayTopologyToNodes(hubMac: string, hubAssignment: TopologyAssignment): Promise<void> {
        const members = new Set(hubAssignment.members.map(member => normalizeMac(member.mac)));
        for (const member of hubAssignment.members) {
            const mac = normalizeMac(member.mac);
            if (mac === hubMac) continue;
            const node = this.devices.get(mac);
            if (!node || node.brokerConnected) continue;
            await this.applyAssignment(mac, deriveMemberAssignment(hubAssignment, member));
        }
        for (const [mac, assignment] of [...this.assignments.entries()]) {
            if (
                mac !== hubMac
                && !members.has(mac)
                && assignment.network_id === hubAssignment.network_id
                && assignment.topology_epoch < hubAssignment.topology_epoch
                && this.devices.get(mac)?.brokerConnected === false
            ) {
                await this.revokeDeviceOwnership(mac);
            }
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
