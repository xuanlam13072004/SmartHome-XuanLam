import crypto from 'crypto';
import type { Pool } from 'pg';
import type Redis from 'ioredis';
import { env } from '../config/env';
// @ts-ignore - shared CommonJS constants
import { CACHE_PREFIXES, REDIS_CHANNELS } from '../../../shared/constants';
import {
    acknowledgeHubAssignment,
    transitionTopologyForHubFailure,
} from '../modules/device/topologyRepository';

type Logger = {
    debug: (obj: unknown, message?: string) => void;
    info: (obj: unknown, message?: string) => void;
    warn: (obj: unknown, message?: string) => void;
    error: (obj: unknown, message?: string) => void;
};

type CachedMember = {
    device_id: string;
    mac: string;
    join_rank: number;
    role: 'hub' | 'node';
};

type CachedTopology = {
    network_id: string;
    owner_id: string;
    active_hub_device_id: string | null;
    active_hub_mac: string | null;
    topology_epoch: number;
    topology_state: 'stable' | 'degraded_direct' | 'electing' | 'empty';
    topology_updated_at?: string;
    members: CachedMember[];
};

const RELEASE_LOCK = `
if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
end
return 0
`;

function parseTopology(raw: string | null): CachedTopology | null {
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
        !parsed.network_id
        || !Number.isSafeInteger(Number(parsed.topology_epoch))
        || !Array.isArray(parsed.members)
    ) {
        return null;
    }
    return {
        ...parsed,
        topology_epoch: Number(parsed.topology_epoch),
        members: parsed.members.map((member: CachedMember) => ({
            ...member,
            join_rank: Number(member.join_rank),
        })),
    };
}

export class TopologyCoordinator {
    private subscriber: Redis | null = null;
    private sweepTimer: NodeJS.Timeout | null = null;
    private running = false;
    private sweepRunning = false;
    private backgroundTasks = new Set<Promise<void>>();

    constructor(
        private readonly pgPool: Pool,
        private readonly redis: Redis,
        private readonly logger: Logger
    ) {}

    async start() {
        if (this.running) return;
        this.running = true;

        await this.redis.config('SET', 'notify-keyspace-events', 'Ex')
            .catch(err => this.logger.warn(
                { err },
                'Could not enable Redis expiry notifications for Hub leases'
            ));

        this.subscriber = this.redis.duplicate();
        await this.subscriber.ping();
        await this.subscriber.subscribe(REDIS_CHANNELS.TOPOLOGY_HUB_ACK);
        await this.subscriber.psubscribe('__keyevent@*__:expired');
        this.subscriber.on('message', (channel, raw) => {
            if (channel === REDIS_CHANNELS.TOPOLOGY_HUB_ACK) {
                this.track(this.handleHubAck(raw));
            }
        });
        this.subscriber.on('pmessage', (_pattern, _channel, key) => {
            if (key.startsWith(CACHE_PREFIXES.HUB_LEASE)) {
                const networkId = key.slice(CACHE_PREFIXES.HUB_LEASE.length);
                this.track(this.evaluateNetwork(networkId, 'hub_lease_expired'));
            }
        });

        this.sweepTimer = setInterval(() => {
            this.track(this.sweep());
        }, 5000);
        this.sweepTimer.unref();
        await this.sweep();
        this.logger.info({}, 'Topology Coordinator started');
    }

    private track(task: Promise<void>) {
        this.backgroundTasks.add(task);
        void task.finally(() => this.backgroundTasks.delete(task));
    }

    private async getOnlineSuccessor(topology: CachedTopology) {
        const candidates = [...topology.members]
            .filter(member => member.device_id !== topology.active_hub_device_id)
            .sort((left, right) => (
                left.join_rank - right.join_rank
                || left.device_id.localeCompare(right.device_id)
            ));
        if (candidates.length === 0) return null;

        const pipeline = this.redis.pipeline();
        for (const candidate of candidates) {
            pipeline.exists(`${CACHE_PREFIXES.ONLINE_LEASE}${candidate.mac}`);
            pipeline.exists(
                `${CACHE_PREFIXES.ELECTION_FAILED}`
                + `${topology.network_id}:${candidate.device_id}`
            );
        }
        const results = await pipeline.exec();
        if (!results) return null;

        for (let index = 0; index < candidates.length; index += 1) {
            const online = Number(results[index * 2]?.[1] || 0) === 1;
            const recentlyFailed = Number(results[index * 2 + 1]?.[1] || 0) === 1;
            if (online && !recentlyFailed) return candidates[index];
        }
        return null;
    }

    private async hubLeaseIsCurrent(topology: CachedTopology) {
        if (!topology.active_hub_mac) return false;
        const raw = await this.redis.get(
            `${CACHE_PREFIXES.HUB_LEASE}${topology.network_id}`
        );
        if (!raw) return false;
        try {
            const lease = JSON.parse(raw);
            return (
                String(lease.hub_mac).toUpperCase()
                    === topology.active_hub_mac.toUpperCase()
                && Number(lease.topology_epoch) === topology.topology_epoch
            );
        } catch {
            return false;
        }
    }

    private async evaluateNetwork(networkId: string, reason: string) {
        if (!this.running) return;
        const lockKey = `${CACHE_PREFIXES.ELECTION_LOCK}${networkId}`;
        const lockToken = crypto.randomUUID();
        const acquired = await this.redis.set(
            lockKey,
            lockToken,
            'EX',
            15,
            'NX'
        );
        if (acquired !== 'OK') return;

        try {
            const topology = parseTopology(await this.redis.get(
                `${CACHE_PREFIXES.TOPOLOGY_NETWORK}${networkId}`
            ));
            if (!topology || topology.topology_state === 'empty') {
                return;
            }
            const hubLeaseIsCurrent = await this.hubLeaseIsCurrent(topology);
            if (topology.topology_state === 'electing') {
                if (
                    hubLeaseIsCurrent
                    && topology.active_hub_device_id
                    && topology.active_hub_mac
                ) {
                    await this.handleHubAck(JSON.stringify({
                        network_id: topology.network_id,
                        device_id: topology.active_hub_device_id,
                        mac: topology.active_hub_mac,
                        topology_epoch: topology.topology_epoch,
                        status: 'ready',
                    }));
                } else {
                    const updatedAt = topology.topology_updated_at
                        ? new Date(topology.topology_updated_at).getTime()
                        : Date.now();
                    const timedOut = (
                        Date.now() - updatedAt
                        >= env.TOPOLOGY_ELECTION_TIMEOUT_SECONDS * 1000
                    );
                    if (timedOut && topology.active_hub_device_id) {
                        await this.handleHubAck(JSON.stringify({
                            network_id: topology.network_id,
                            device_id: topology.active_hub_device_id,
                            mac: topology.active_hub_mac,
                            topology_epoch: topology.topology_epoch,
                            status: 'error',
                        }));
                    }
                }
                return;
            }
            if (hubLeaseIsCurrent) return;

            const candidate = await this.getOnlineSuccessor(topology);
            if (!candidate) return;

            if (topology.active_hub_device_id) {
                await this.redis.set(
                    `${CACHE_PREFIXES.ELECTION_FAILED}`
                    + `${networkId}:${topology.active_hub_device_id}`,
                    '1',
                    'EX',
                    60
                );
            }

            const client = await this.pgPool.connect();
            try {
                await client.query('BEGIN');
                const result = await transitionTopologyForHubFailure(client, {
                    networkId,
                    expectedEpoch: topology.topology_epoch,
                    candidateDeviceId: candidate.device_id,
                });
                await client.query('COMMIT');
                if (result) {
                    this.logger.warn(
                        {
                            networkId,
                            previousHub: topology.active_hub_mac,
                            candidateHub: candidate.mac,
                            previousEpoch: topology.topology_epoch,
                            reason,
                        },
                        'Hub failover election started'
                    );
                }
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
        } catch (err) {
            this.logger.error(
                { err, networkId, reason },
                'Failed to evaluate Hub failover'
            );
        } finally {
            await this.redis.eval(RELEASE_LOCK, 1, lockKey, lockToken)
                .catch(() => undefined);
        }
    }

    private async handleHubAck(raw: string) {
        try {
            const ack = JSON.parse(raw);
            if (
                !ack.network_id
                || !ack.device_id
                || !['ready', 'error'].includes(ack.status)
                || !Number.isSafeInteger(Number(ack.topology_epoch))
            ) {
                return;
            }

            const client = await this.pgPool.connect();
            try {
                await client.query('BEGIN');
                const result = await acknowledgeHubAssignment(client, {
                    networkId: ack.network_id,
                    expectedEpoch: Number(ack.topology_epoch),
                    hubDeviceId: ack.device_id,
                    status: ack.status,
                });
                await client.query('COMMIT');
                if (result && ack.status === 'ready') {
                    await this.redis.del(
                        `${CACHE_PREFIXES.ELECTION_FAILED}`
                        + `${ack.network_id}:${ack.device_id}`
                    );
                    if (result.active_hub_mac) {
                        await this.redis.set(
                            `${CACHE_PREFIXES.HUB_LEASE}${ack.network_id}`,
                            JSON.stringify({
                                network_id: ack.network_id,
                                hub_mac: result.active_hub_mac,
                                topology_epoch: result.topology_epoch,
                            }),
                            'EX',
                            env.TOPOLOGY_HUB_LEASE_SECONDS
                        );
                    }
                } else if (result && ack.status === 'error') {
                    await this.redis.del(
                        `${CACHE_PREFIXES.HUB_LEASE}${ack.network_id}`
                    );
                    await this.redis.set(
                        `${CACHE_PREFIXES.ELECTION_FAILED}`
                        + `${ack.network_id}:${ack.device_id}`,
                        '1',
                        'EX',
                        60
                    );
                }
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
        } catch (err) {
            this.logger.error({ err }, 'Failed to process topology Hub ACK');
        }
    }

    private async sweep() {
        if (!this.running || this.sweepRunning) return;
        this.sweepRunning = true;
        try {
            let cursor = '0';
            do {
                const [nextCursor, keys] = await this.redis.scan(
                    cursor,
                    'MATCH',
                    `${CACHE_PREFIXES.TOPOLOGY_NETWORK}*`,
                    'COUNT',
                    100
                );
                cursor = nextCursor;
                for (const key of keys) {
                    const networkId = key.slice(
                        CACHE_PREFIXES.TOPOLOGY_NETWORK.length
                    );
                    await this.evaluateNetwork(networkId, 'periodic_sweep');
                }
            } while (cursor !== '0' && this.running);
        } catch (err) {
            this.logger.error({ err }, 'Topology Coordinator sweep failed');
        } finally {
            this.sweepRunning = false;
        }
    }

    async stop() {
        this.running = false;
        if (this.sweepTimer) clearInterval(this.sweepTimer);
        if (this.subscriber) {
            await this.subscriber.quit().catch(() => this.subscriber?.disconnect());
        }
        await Promise.allSettled([...this.backgroundTasks]);
    }
}
