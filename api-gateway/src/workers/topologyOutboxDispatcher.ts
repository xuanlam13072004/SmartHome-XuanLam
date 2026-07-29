import type { Pool } from 'pg';
import type Redis from 'ioredis';
import type { Db } from 'mongodb';
import { env } from '../config/env';
// @ts-ignore - shared CommonJS constants
import { CACHE_PREFIXES, REDIS_CHANNELS } from '../../../shared/constants';

type Logger = {
    debug: (obj: unknown, message?: string) => void;
    info: (obj: unknown, message?: string) => void;
    warn: (obj: unknown, message?: string) => void;
    error: (obj: unknown, message?: string) => void;
};

type TopologyMember = {
    device_id: string;
    mac: string;
    join_rank: number;
    role: 'hub' | 'node';
};

type TopologyPayload = {
    schema_version: number;
    network_id: string;
    owner_id: string;
    active_hub_device_id: string | null;
    active_hub_mac: string | null;
    topology_epoch: number;
    topology_state: 'stable' | 'degraded_direct' | 'electing' | 'empty';
    members: TopologyMember[];
    change: {
        type: 'claim' | 'unpair' | 'hub_failure' | 'hub_ack';
        device_id: string;
        mac: string;
        hub_changed: boolean;
    };
};

type TopologyEvent = {
    id: number;
    network_id: string;
    topology_epoch: number;
    reason: string;
    created_at: Date;
    payload: TopologyPayload;
};

const APPLY_JSON_IF_NEWER = `
local current = redis.call('GET', KEYS[1])
if current then
    local ok, decoded = pcall(cjson.decode, current)
    if ok and decoded[ARGV[1]]
       and tonumber(decoded[ARGV[1]]) > tonumber(ARGV[2]) then
        return 0
    end
end
redis.call('SET', KEYS[1], ARGV[3])
return 1
`;

const DELETE_JSON_IF_NOT_NEWER = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local ok, decoded = pcall(cjson.decode, current)
if not ok or not decoded[ARGV[1]]
   or tonumber(decoded[ARGV[1]]) <= tonumber(ARGV[2]) then
    return redis.call('DEL', KEYS[1])
end
return 0
`;

function topologyNetworkKey(networkId: string) {
    return `${CACHE_PREFIXES.TOPOLOGY_NETWORK}${networkId}`;
}

function topologyDeviceKey(mac: string) {
    return `${CACHE_PREFIXES.TOPOLOGY_DEVICE}${mac}`;
}

function transportMode(
    member: TopologyMember,
    state: TopologyPayload['topology_state']
) {
    if (member.role === 'hub') return 'hub';
    return state === 'stable' ? 'relay' : 'direct_fallback';
}

async function applyTopologyCache(
    redis: Redis,
    event: TopologyEvent
) {
    const payload = event.payload;
    const networkCache = {
        ...payload,
        event_id: event.id,
        reason: event.reason,
        topology_updated_at: event.created_at.toISOString(),
    };
    const networkApplied = await redis.eval(
        APPLY_JSON_IF_NEWER,
        1,
        topologyNetworkKey(payload.network_id),
        'topology_epoch',
        String(payload.topology_epoch),
        JSON.stringify(networkCache)
    );
    if (Number(networkApplied) === 0) return false;

    for (const member of payload.members) {
        await redis.del(`${CACHE_PREFIXES.TOPOLOGY_REMOVED}${member.mac}`);
        const deviceCache = {
            event_id: event.id,
            network_id: payload.network_id,
            owner_id: payload.owner_id,
            device_id: member.device_id,
            mac: member.mac,
            join_rank: member.join_rank,
            role: member.role,
            active_hub_device_id: payload.active_hub_device_id,
            active_hub_mac: payload.active_hub_mac,
            topology_epoch: payload.topology_epoch,
            topology_state: payload.topology_state,
            transport_mode: transportMode(member, payload.topology_state),
            member_count: payload.members.length,
        };
        await redis.eval(
            APPLY_JSON_IF_NEWER,
            1,
            topologyDeviceKey(member.mac),
            'event_id',
            String(event.id),
            JSON.stringify(deviceCache)
        );
    }

    const changedMac = payload.change?.mac;
    if (
        payload.change?.type === 'unpair'
        && changedMac
        && !payload.members.some(member => member.mac === changedMac)
    ) {
        await redis.eval(
            DELETE_JSON_IF_NOT_NEWER,
            1,
            topologyDeviceKey(changedMac),
            'event_id',
            String(event.id)
        );
        await redis.set(
            `${CACHE_PREFIXES.TOPOLOGY_REMOVED}${changedMac}`,
            JSON.stringify({ event_id: event.id, mac: changedMac }),
            'EX',
            7 * 24 * 60 * 60
        );
        await redis.publish(
            REDIS_CHANNELS.TOPOLOGY_REMOVED,
            JSON.stringify({ event_id: event.id, mac: changedMac })
        );
    }

    const routeKey = `${CACHE_PREFIXES.TOPOLOGY_ROUTE}${payload.network_id}`;
    if (payload.topology_state === 'stable' || payload.topology_state === 'empty') {
        await redis.del(routeKey);
    } else {
        await redis.set(
            routeKey,
            JSON.stringify({
                mode: 'direct_fallback',
                topology_epoch: payload.topology_epoch,
                event_id: event.id,
            })
        );
    }
    if (payload.change?.hub_changed || payload.topology_state !== 'stable') {
        await redis.del(`${CACHE_PREFIXES.HUB_LEASE}${payload.network_id}`);
    }

    await redis.publish(
        REDIS_CHANNELS.TOPOLOGY_UPDATED,
        JSON.stringify(networkCache)
    );
    return true;
}

async function applyMonotonicTopologyShadow(
    mongoDb: Db,
    eventId: number,
    mac: string,
    fields: Record<string, unknown>
) {
    const collection = mongoDb.collection<any>(env.MONGO_DEVICES_COLLECTION);
    const filter = {
        _id: mac,
        $or: [
            { topology_outbox_event_id: { $exists: false } },
            { topology_outbox_event_id: { $lt: eventId } },
        ],
    };
    const update = {
        $set: {
            ...fields,
            topology_outbox_event_id: eventId,
        },
    };
    try {
        await collection.updateOne(filter, update, { upsert: true });
    } catch (err: any) {
        if (err?.code !== 11000) throw err;
        await collection.updateOne(filter, update);
    }
}

async function applyTopologyShadow(
    mongoDb: Db,
    event: TopologyEvent
) {
    const payload = event.payload;
    const now = new Date();
    const operations = payload.members.map(member =>
        applyMonotonicTopologyShadow(
            mongoDb,
            event.id,
            member.mac,
            {
                network_id: payload.network_id,
                active_hub_mac: payload.active_hub_mac,
                topology_epoch: payload.topology_epoch,
                topology_state: payload.topology_state,
                topology_role: member.role,
                transport_mode: transportMode(member, payload.topology_state),
                last_transport_change: now,
            }
        )
    );

    const changedMac = payload.change?.mac;
    if (
        payload.change?.type === 'unpair'
        && changedMac
        && !payload.members.some(member => member.mac === changedMac)
    ) {
        operations.push(applyMonotonicTopologyShadow(
            mongoDb,
            event.id,
            changedMac,
            {
                network_id: null,
                active_hub_mac: null,
                topology_epoch: null,
                topology_state: null,
                topology_role: null,
                transport_mode: 'offline',
                last_transport_change: now,
            }
        ));
    }

    if (operations.length > 0) {
        await Promise.all(operations);
    }
}

async function requeueCommandsForTopologyChange(
    pgPool: Pool,
    redis: Redis,
    event: TopologyEvent,
    logger: Logger
) {
    if (env.TOPOLOGY_COMMAND_REROUTE_LIMIT === 0) return;
    const result = await pgPool.query(
        `SELECT command.id, command.mac, command.status,
                command.retry_count
         FROM device_commands AS command
         JOIN device_metadata AS device
           ON device.owner_id = command.owner_id
          AND device.mac = command.mac
         JOIN command_outbox AS command_outbox
           ON command_outbox.command_id = command.id
         WHERE device.network_id = $1
           AND (
               command.status IN ('sending', 'sent')
               OR (
                   command.status = 'pending'
                   AND command_outbox.published_at IS NOT NULL
               )
           )
           AND command.retry_count < $2`,
        [event.network_id, env.TOPOLOGY_COMMAND_REROUTE_LIMIT]
    );

    for (const command of result.rows) {
        const routeRaw = await redis.get(
            `${CACHE_PREFIXES.COMMAND_ROUTE}${command.id}`
        );
        if (!routeRaw) continue;
        let route: any = null;
        try {
            route = routeRaw ? JSON.parse(routeRaw) : null;
        } catch {
            route = null;
        }
        const routeIsCurrent = Boolean(
            route
            && route.network_id === event.network_id
            && Number(route.topology_epoch) === event.topology_epoch
        );
        if (routeIsCurrent) continue;

        const client = await pgPool.connect();
        try {
            await client.query('BEGIN');
            const updateResult = await client.query(
                `UPDATE device_commands
                 SET status = 'pending',
                     retry_count = retry_count + 1,
                     event_version = event_version + 1,
                     error_log = 'Topology changed; command queued for reroute',
                     updated_at = NOW()
                 WHERE id = $1
                   AND status IN ('pending', 'sending', 'sent')
                   AND retry_count < $2
                 RETURNING event_version`,
                [command.id, env.TOPOLOGY_COMMAND_REROUTE_LIMIT]
            );
            if (updateResult.rows.length === 1) {
                await client.query(
                    `UPDATE command_outbox
                     SET published_at = NULL,
                         last_error = NULL,
                         updated_at = NOW()
                     WHERE command_id = $1`,
                    [command.id]
                );
            }
            await client.query('COMMIT');
            if (updateResult.rows.length === 1) {
                logger.info(
                    {
                        commandId: command.id,
                        mac: command.mac,
                        topologyEpoch: event.topology_epoch,
                    },
                    'Command queued for topology-aware reroute'
                );
            }
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }
}

export async function dispatchTopologyOutboxEvent(
    pgPool: Pool,
    redis: Redis,
    mongoDb: Db,
    logger: Logger,
    eventId: number
) {
    const result = await pgPool.query(
        `SELECT current.id, current.network_id, current.topology_epoch,
                current.reason, current.created_at, current.payload
         FROM topology_outbox AS current
         WHERE current.id = $1
           AND current.processed_at IS NULL
           AND NOT EXISTS (
               SELECT 1
               FROM topology_outbox AS earlier
               WHERE earlier.network_id = current.network_id
                 AND earlier.processed_at IS NULL
                 AND earlier.id < current.id
           )`,
        [eventId]
    );
    if (result.rows.length === 0) return;

    const row = result.rows[0];
    const event: TopologyEvent = {
        id: Number(row.id),
        network_id: row.network_id,
        topology_epoch: Number(row.topology_epoch),
        reason: row.reason,
        created_at: new Date(row.created_at),
        payload: row.payload,
    };

    try {
        const applied = await applyTopologyCache(redis, event);
        if (applied) {
            await applyTopologyShadow(mongoDb, event);
            await requeueCommandsForTopologyChange(
                pgPool,
                redis,
                event,
                logger
            );
        }
        await pgPool.query(
            `UPDATE topology_outbox
             SET processed_at = NOW(), attempts = attempts + 1,
                 last_error = NULL, updated_at = NOW()
             WHERE id = $1 AND processed_at IS NULL`,
            [event.id]
        );
        logger.debug(
            { eventId: event.id, networkId: event.network_id, epoch: event.topology_epoch },
            'Topology outbox event applied'
        );
    } catch (err: any) {
        await pgPool.query(
            `UPDATE topology_outbox
             SET attempts = attempts + 1, last_error = $2, updated_at = NOW()
             WHERE id = $1`,
            [event.id, String(err?.message || err).slice(0, 2000)]
        ).catch(updateErr => logger.warn(
            { updateErr, eventId: event.id },
            'Failed to record topology outbox error'
        ));
        throw err;
    }
}

async function deleteKeysByPrefix(redis: Redis, prefix: string) {
    let cursor = '0';
    do {
        const [nextCursor, keys] = await redis.scan(
            cursor,
            'MATCH',
            `${prefix}*`,
            'COUNT',
            500
        );
        cursor = nextCursor;
        for (let index = 0; index < keys.length; index += 500) {
            await redis.del(...keys.slice(index, index + 500));
        }
    } while (cursor !== '0');
}

export async function synchronizeTopologyCache(
    pgPool: Pool,
    redis: Redis,
    logger: Logger
) {
    const [networkResult, memberResult, removedResult] = await Promise.all([
        pgPool.query(
            `SELECT n.id, n.owner_id, n.active_hub_device_id,
                    n.topology_epoch, n.topology_state, n.updated_at,
                    hub.mac AS active_hub_mac,
                    COALESCE(MAX(outbox.id), 0) AS event_id
             FROM device_networks AS n
             LEFT JOIN device_metadata AS hub
               ON hub.id = n.active_hub_device_id
             LEFT JOIN topology_outbox AS outbox
               ON outbox.network_id = n.id
             GROUP BY n.id, hub.mac`
        ),
        pgPool.query(
            `SELECT id AS device_id, owner_id, mac, network_id, join_rank
             FROM device_metadata
             WHERE network_id IS NOT NULL
             ORDER BY network_id, join_rank ASC, id ASC`
        ),
        pgPool.query(
            `SELECT MAX(outbox.id) AS event_id,
                    outbox.payload #>> '{change,mac}' AS mac
             FROM topology_outbox AS outbox
             WHERE outbox.payload #>> '{change,type}' = 'unpair'
               AND COALESCE(outbox.payload #>> '{change,mac}', '') <> ''
               AND NOT EXISTS (
                   SELECT 1
                   FROM device_metadata AS device
                   WHERE device.mac = outbox.payload #>> '{change,mac}'
               )
             GROUP BY outbox.payload #>> '{change,mac}'`
        ),
    ]);

    await deleteKeysByPrefix(redis, CACHE_PREFIXES.TOPOLOGY_NETWORK);
    await deleteKeysByPrefix(redis, CACHE_PREFIXES.TOPOLOGY_DEVICE);
    await deleteKeysByPrefix(redis, CACHE_PREFIXES.TOPOLOGY_REMOVED);

    const membersByNetwork = new Map<string, TopologyMember[]>();
    for (const row of memberResult.rows) {
        const members = membersByNetwork.get(row.network_id) || [];
        members.push({
            device_id: row.device_id,
            mac: row.mac,
            join_rank: Number(row.join_rank),
            role: 'node',
        });
        membersByNetwork.set(row.network_id, members);
    }

    const pipeline = redis.pipeline();
    const synchronizedPayloads: Array<TopologyPayload & {
        event_id: number;
        reason: string;
        topology_updated_at: string;
    }> = [];
    for (const network of networkResult.rows) {
        const members = membersByNetwork.get(network.id) || [];
        for (const member of members) {
            if (member.device_id === network.active_hub_device_id) {
                member.role = 'hub';
            }
        }
        const payload: TopologyPayload & {
            event_id: number;
            reason: string;
            topology_updated_at: string;
        } = {
            schema_version: 1,
            event_id: Number(network.event_id),
            reason: 'startup_sync',
            topology_updated_at: new Date(network.updated_at).toISOString(),
            network_id: network.id,
            owner_id: network.owner_id,
            active_hub_device_id: network.active_hub_device_id,
            active_hub_mac: network.active_hub_mac,
            topology_epoch: Number(network.topology_epoch),
            topology_state: network.topology_state,
            members,
            change: {
                type: 'hub_ack',
                device_id: network.active_hub_device_id || '',
                mac: network.active_hub_mac || '',
                hub_changed: false,
            },
        };
        synchronizedPayloads.push(payload);
        pipeline.set(topologyNetworkKey(network.id), JSON.stringify(payload));
        for (const member of members) {
            pipeline.set(topologyDeviceKey(member.mac), JSON.stringify({
                event_id: payload.event_id,
                network_id: payload.network_id,
                owner_id: payload.owner_id,
                device_id: member.device_id,
                mac: member.mac,
                join_rank: member.join_rank,
                role: member.role,
                active_hub_device_id: payload.active_hub_device_id,
                active_hub_mac: payload.active_hub_mac,
                topology_epoch: payload.topology_epoch,
                topology_state: payload.topology_state,
                transport_mode: transportMode(member, payload.topology_state),
                member_count: members.length,
            }));
        }
    }
    for (const removed of removedResult.rows) {
        pipeline.set(
            `${CACHE_PREFIXES.TOPOLOGY_REMOVED}${removed.mac}`,
            JSON.stringify({
                event_id: Number(removed.event_id),
                mac: removed.mac,
            }),
            'EX',
            7 * 24 * 60 * 60
        );
    }
    const results = await pipeline.exec();
    const failed = results?.find(([err]) => err);
    if (failed) throw failed[0];
    for (const payload of synchronizedPayloads) {
        await redis.publish(
            REDIS_CHANNELS.TOPOLOGY_UPDATED,
            JSON.stringify(payload)
        );
    }
    for (const removed of removedResult.rows) {
        await redis.publish(
            REDIS_CHANNELS.TOPOLOGY_REMOVED,
            JSON.stringify({
                event_id: Number(removed.event_id),
                mac: removed.mac,
            })
        );
    }

    logger.info(
        {
            networks: networkResult.rows.length,
            members: memberResult.rows.length,
            removed: removedResult.rows.length,
        },
        'Topology cache synchronized from PostgreSQL'
    );
}

export class TopologyOutboxDispatcher {
    private timer: NodeJS.Timeout | null = null;
    private running = false;
    private inFlight: Promise<void> | null = null;

    constructor(
        private readonly pgPool: Pool,
        private readonly redis: Redis,
        private readonly mongoDb: Db,
        private readonly logger: Logger
    ) {}

    start() {
        if (this.running) return;
        this.running = true;
        this.schedule(0);
    }

    private schedule(delayMs: number) {
        if (!this.running) return;
        this.timer = setTimeout(() => {
            this.inFlight = this.dispatchBatch()
                .catch(err => this.logger.error(
                    { err },
                    'Topology outbox dispatch failed'
                ))
                .finally(() => {
                    this.inFlight = null;
                    this.schedule(500);
                });
        }, delayMs);
        this.timer.unref();
    }

    private async dispatchBatch() {
        const result = await this.pgPool.query(
            `SELECT current.id
             FROM topology_outbox AS current
             WHERE current.processed_at IS NULL
               AND NOT EXISTS (
                   SELECT 1
                   FROM topology_outbox AS earlier
                   WHERE earlier.network_id = current.network_id
                     AND earlier.processed_at IS NULL
                     AND earlier.id < current.id
               )
             ORDER BY current.id ASC
             LIMIT 100`
        );
        for (const row of result.rows) {
            await dispatchTopologyOutboxEvent(
                this.pgPool,
                this.redis,
                this.mongoDb,
                this.logger,
                Number(row.id)
            ).catch(err => this.logger.warn(
                { err, eventId: row.id },
                'Topology event will be retried'
            ));
        }
    }

    async stop() {
        this.running = false;
        if (this.timer) clearTimeout(this.timer);
        if (this.inFlight) await this.inFlight;
    }
}
