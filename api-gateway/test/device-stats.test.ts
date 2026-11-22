import './setup-env';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { MongoClient, ObjectId } from 'mongodb';
import deviceRoutes from '../src/modules/device/routes';
import {
    bucketStarts,
    chartMeasures,
    commandLabels,
    shapeCounts,
    shapeMeasures,
    statsWindow,
    telemetryPipeline,
} from '../src/modules/device/stats';
import { RuntimeCatalog } from '../../shared/catalog-v2';
import { createTestDatabase, skipWithoutMongo, TEST_MONGO_URL, TestDatabase } from './helpers/testDatabase';
import { buildTestApp, signUp } from './helpers/testApp';
import { addMember, createOwnedDevice } from './helpers/fixtures';

test('hours and days are cut in Vietnam time, ending with the current one', () => {
    const now = new Date('2026-11-22T10:30:00Z'); // 17:30 in Hà Nội
    const day = statsWindow('24h', now);
    assert.equal(day.unit, 'hour');
    assert.equal(day.start.toISOString(), '2026-11-21T11:00:00.000Z');
    const hours = bucketStarts(day);
    assert.equal(hours.length, 24);
    assert.equal(hours[23], '2026-11-22T10:00:00.000Z');

    const week = statsWindow('7d', now);
    assert.equal(week.start.toISOString(), '2026-11-15T17:00:00.000Z', 'midnight of 16/11 in Hà Nội');
    assert.equal(bucketStarts(week)[6], '2026-11-21T17:00:00.000Z', 'today: 22/11');
    // 00:30 of 23/11 in Hà Nội is already a new day.
    assert.equal(bucketStarts(statsWindow('7d', new Date('2026-11-22T17:30:00Z')))[6], '2026-11-22T17:00:00.000Z');
    assert.equal(bucketStarts(statsWindow('30d', now)).length, 30);
});

test('charts bounded sampled readings and counts real commands only', async () => {
    const catalog = await new RuntimeCatalog({ log: { info: () => undefined } }).start();
    const kitchen = chartMeasures(catalog.getProduct('prod_hazard_mitigation'));
    assert.deepEqual(kitchen.map(item => item.property), [
        'instances.kitchen_gas.reported.gas_level',
        'instances.kitchen_smoke.reported.smoke_level',
        'instances.kitchen_temperature.reported.temperature',
        'instances.kitchen_humidity.reported.humidity',
        'diagnostics.system.wifi_rssi',
    ], 'uptime has no upper bound');
    const temperature = kitchen[2];
    assert.equal(temperature.label, 'Nhiệt độ');
    assert.equal(temperature.unit, 'celsius');
    assert.equal(temperature.precision, 1);
    assert.deepEqual(
        chartMeasures(catalog.getProduct('prod_security_camera')).map(item => item.property),
        ['diagnostics.system.wifi_rssi'],
        'storage bytes keep only the latest value',
    );

    const camera = commandLabels(catalog.getProduct('prod_security_camera'));
    assert.equal(camera.has('recording.list_recordings'), false, 'listing recordings is a query');
    assert.equal(camera.get('recording.delete_recordings'), 'Xóa bản ghi');
});

test('shapes readings and counts into one slot per bucket', () => {
    const measures = [
        { property: 'a', label: 'A', instance_label: 'A', unit: null, minimum: 0, maximum: 100, precision: 1 },
        { property: 'b', label: 'B', instance_label: 'B', unit: null, minimum: 0, maximum: 10, precision: 0 },
    ];
    const series = shapeMeasures(measures, [
        { _id: 0, avg0: 21.456, min0: 20, max0: 23.04, avg1: null, min1: null, max1: null },
        { _id: 2, avg0: 30, min0: 30, max0: 30, avg1: 4.6, min1: 4, max1: 5 },
        { _id: 5, avg0: 1, min0: 1, max0: 1 }, // outside the range: ignored
    ], 3);
    assert.deepEqual(series[0].points, [{ avg: 21.5, min: 20, max: 23 }, null, { avg: 30, min: 30, max: 30 }]);
    assert.deepEqual(series[1].points, [null, null, { avg: 5, min: 4, max: 5 }]);

    const counts = shapeCounts([
        { bucket: 0, key: 'door_opened', count: 2 },
        { bucket: 1, key: 'door_opened', count: 3 },
        { bucket: 1, key: 'door_closed', count: 5 },
        { bucket: -1, key: 'door_closed', count: 9 },
    ], 2, key => key === 'door_opened' ? 'Cửa được mở' : 'Cửa được đóng');
    assert.equal(counts.total, 10);
    assert.deepEqual(counts.per_bucket, [2, 8]);
    assert.deepEqual(counts.items.map(item => [item.key, item.count]), [['door_closed', 5], ['door_opened', 5]]);
});

test('reads telemetry of the current owner only, from the viewer\'s start', () => {
    const window = statsWindow('24h', new Date('2026-11-22T10:30:00Z'));
    const from = new Date('2026-11-22T08:00:00Z');
    const pipeline = telemetryPipeline({ mac: 'AA:BB:CC:00:00:01', ownerId: 'owner-1', from, window, paths: ['x.y'] }) as any[];
    assert.deepEqual(pipeline[0].$match, {
        'metadata.device_id': 'AA:BB:CC:00:00:01',
        'metadata.owner_id': 'owner-1',
        observed_at: { $gte: from, $lte: window.end },
    });
    assert.deepEqual(Object.keys(pipeline[1].$group), ['_id', 'avg0', 'min0', 'max0']);
});

test.describe('device stats API', { skip: skipWithoutMongo }, () => {
    let db: TestDatabase;
    let app: FastifyInstance;
    let mongo: MongoClient;

    test.before(async () => {
        db = await createTestDatabase();
        mongo = await new MongoClient(TEST_MONGO_URL).connect();
        app = await buildTestApp(db.pool, [deviceRoutes], { client: mongo, db: mongo.db(`device_stats_${Date.now()}`) });
    });
    test.after(async () => {
        await app?.mongo.db.dropDatabase().catch(() => undefined);
        await app?.close();
        await mongo?.close();
        await db?.drop();
    });

    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

    async function reading(mac: string, ownerId: string, at: Date, temperature: number) {
        await app.mongo.db.collection('device_telemetry').insertOne({
            _id: new ObjectId(),
            observed_at: at,
            metadata: { device_id: mac, owner_id: ownerId, product_id: 'prod_hazard_mitigation' },
            instances: { kitchen_temperature: { reported: { temperature } } },
            diagnostics: { system: { wifi_rssi: -60 } },
        } as any);
    }

    async function event(mac: string, ownerId: string, name: string, severity: string, at: Date) {
        await app.mongo.db.collection('device_events').insertOne({
            _id: new ObjectId(), event_id: `evt-${new ObjectId()}`, device_id: mac, owner_id: ownerId,
            event_name: name, severity, received_at: at, occurred_at: at, data: {},
        } as any);
    }

    async function command(device: { id: string }, actorId: string, key: string, status: string, at: Date) {
        const [instance, operation] = key.split('.');
        const permission = (app.catalog.getOperation('prod_hazard_mitigation', instance, operation) as any).permission;
        await db.pool.query(
            `INSERT INTO device_operations (device_id, actor_account_id, instance_id, operation_name, permission_scope,
                risk, status, catalog_revision, accepted_at, created_at, timeout_at, completed_at)
             VALUES ($1, $2, $3, $4, $5, 'normal', $6, 1, $7, $7, $7::timestamptz + interval '1 minute',
                CASE WHEN $6 = 'executing' THEN NULL ELSE $7::timestamptz + interval '1 second' END)`,
            [device.id, actorId, instance, operation, permission, status, at],
        );
    }

    function slotOf(stats: any, at: Date): number {
        const starts: number[] = stats.buckets.map((value: string) => Date.parse(value));
        return starts.filter(start => start <= at.getTime()).length - 1;
    }

    test('owner sees readings, every event and succeeded commands; members from joining, alerts only', async () => {
        const owner = await signUp(app);
        const member = await signUp(app);
        const stranger = await signUp(app);
        const kitchen = await createOwnedDevice(db.pool, owner.id, { name: 'Bếp', productId: 'prod_hazard_mitigation' });
        // Claimed ten days ago: everything below happened while it was theirs.
        await db.pool.query(
            `UPDATE device_memberships SET created_at = NOW() - interval '10 days' WHERE device_id = $1`, [kitchen.id]);

        // Two readings in the same hour, more than two hours ago.
        const earlier = Math.floor((Date.now() - 150 * 60_000) / 3_600_000) * 3_600_000;
        await reading(kitchen.mac, owner.id, new Date(earlier + 60_000), 30);
        await reading(kitchen.mac, owner.id, new Date(earlier + 120_000), 32);
        await reading(kitchen.mac, owner.id, minutesAgo(10), 25);
        await reading(kitchen.mac, 'previous-owner', minutesAgo(10), 90);
        await event(kitchen.mac, 'previous-owner', 'button_pressed', 'info', minutesAgo(10));
        await event(kitchen.mac, owner.id, 'button_pressed', 'info', minutesAgo(140));
        await event(kitchen.mac, owner.id, 'smoke_threshold_crossed', 'critical', minutesAgo(140));
        await event(kitchen.mac, owner.id, 'smoke_threshold_crossed', 'critical', minutesAgo(20));
        await event(kitchen.mac, owner.id, 'button_pressed', 'info', minutesAgo(15));
        await command(kitchen, owner.id, 'alarm_siren.test_siren', 'succeeded', minutesAgo(130));
        await command(kitchen, owner.id, 'alarm_siren.test_siren', 'succeeded', minutesAgo(12));
        await command(kitchen, owner.id, 'alarm_siren.mute_siren', 'failed', minutesAgo(11));

        const response = await app.inject({ method: 'GET', url: `/devices/${kitchen.mac}/stats`, headers: owner.headers });
        assert.equal(response.statusCode, 200, response.body);
        const stats = response.json().stats;
        assert.equal(stats.range, '24h');
        assert.equal(stats.unit, 'hour');
        assert.equal(stats.buckets.length, 24);

        const temperature = stats.measures.find((item: any) => item.property.endsWith('.temperature'));
        assert.deepEqual(temperature.points[slotOf(stats, new Date(earlier + 60_000))], { avg: 31, min: 30, max: 32 });
        assert.deepEqual(temperature.points[slotOf(stats, minutesAgo(10))], { avg: 25, min: 25, max: 25 });
        assert.equal(temperature.points.filter(Boolean).length, 2, 'the previous owner\'s 90 °C is not shown');
        const gas = stats.measures.find((item: any) => item.property.endsWith('.gas_level'));
        assert.ok(gas.points.every((point: unknown) => point === null), 'no gas reading reported');

        assert.equal(stats.events.scope, 'all');
        assert.equal(stats.events.total, 4);
        assert.deepEqual(stats.events.by_name.map((item: any) => [item.event_name, item.count]),
            [['button_pressed', 2], ['smoke_threshold_crossed', 2]]);
        assert.equal(stats.commands.total, 2, 'the failed command is not counted');
        assert.deepEqual(stats.commands.by_operation, [{ operation: 'alarm_siren.test_siren', label: 'Kiểm tra còi', count: 2 }]);
        assert.equal(stats.commands.per_bucket[slotOf(stats, minutesAgo(12))], 1);
        assert.equal(stats.since, null);

        await addMember(db.pool, kitchen, owner.id, member.id);
        await db.pool.query(
            `UPDATE device_memberships SET created_at = NOW() - interval '1 hour' WHERE device_id = $1 AND account_id = $2`,
            [kitchen.id, member.id],
        );
        const memberStats = (await app.inject({ method: 'GET', url: `/devices/${kitchen.mac}/stats`, headers: member.headers })).json().stats;
        assert.ok(memberStats.since, 'the member\'s view starts when they joined');
        const memberTemperature = memberStats.measures.find((item: any) => item.property.endsWith('.temperature'));
        assert.equal(memberTemperature.points.filter(Boolean).length, 1);
        assert.equal(memberStats.events.scope, 'alerts');
        assert.deepEqual(memberStats.events.by_name.map((item: any) => [item.event_name, item.count]), [['smoke_threshold_crossed', 1]]);
        assert.equal(memberStats.commands.total, 1);

        const week = (await app.inject({ method: 'GET', url: `/devices/${kitchen.mac}/stats?range=7d`, headers: owner.headers })).json().stats;
        assert.equal(week.unit, 'day');
        assert.equal(week.buckets.length, 7);
        assert.equal(week.events.total, 4);

        const forbidden = await app.inject({ method: 'GET', url: `/devices/${kitchen.mac}/stats`, headers: stranger.headers });
        assert.equal(forbidden.statusCode, 403);
        const invalid = await app.inject({ method: 'GET', url: `/devices/${kitchen.mac}/stats?range=1y`, headers: owner.headers });
        assert.equal(invalid.statusCode, 400);
    });

    test('serves a cached copy for a few minutes', async () => {
        const owner = await signUp(app);
        const device = await createOwnedDevice(db.pool, owner.id, { productId: 'prod_hazard_mitigation' });
        await db.pool.query(
            `UPDATE device_memberships SET created_at = NOW() - interval '1 day' WHERE device_id = $1`, [device.id]);
        const first = (await app.inject({ method: 'GET', url: `/devices/${device.mac}/stats`, headers: owner.headers })).json().stats;
        await event(device.mac, owner.id, 'button_pressed', 'info', minutesAgo(1));
        const second = (await app.inject({ method: 'GET', url: `/devices/${device.mac}/stats`, headers: owner.headers })).json().stats;
        assert.equal(second.generated_at, first.generated_at);
        assert.equal(second.events.total, 0);
    });
});
