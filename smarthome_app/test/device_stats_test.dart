import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:smarthome_app/core/core.dart';
import 'package:smarthome_app/features/device_stats/data/device_stats.dart';
import 'package:smarthome_app/features/device_stats/widgets/stats_charts.dart';

Map<String, dynamic> _json() => {
      'range': '24h',
      'unit': 'hour',
      'timezone': 'Asia/Ho_Chi_Minh',
      'buckets': ['2026-11-22T07:00:00.000Z', '2026-11-22T08:00:00.000Z', '2026-11-22T09:00:00.000Z'],
      'since': null,
      'measures': [
        {
          'property': 'instances.kitchen_temperature.reported.temperature',
          'label': 'Nhiệt độ',
          'instance_label': 'Nhiệt độ DHT11',
          'unit': 'celsius',
          'minimum': -40,
          'maximum': 125,
          'precision': 1,
          'points': [
            {'avg': 30.5, 'min': 29, 'max': 32},
            null,
            {'avg': 27.25, 'min': 26, 'max': 28},
          ],
        },
        {
          'property': 'diagnostics.system.wifi_rssi',
          'label': 'Tín hiệu Wi-Fi',
          'unit': 'dbm',
          'minimum': -120,
          'maximum': 0,
          'precision': 0,
          'points': [null, null, null],
        },
      ],
      'events': {
        'scope': 'alerts',
        'total': 3,
        'per_bucket': [1, 0, 2],
        'by_name': [
          {'event_name': 'smoke_threshold_crossed', 'label': 'Khói vượt ngưỡng', 'count': 3},
        ],
      },
      'commands': {'total': 0, 'per_bucket': [0, 0, 0], 'by_operation': []},
      'generated_at': '2026-11-22T09:30:00.000Z',
    };

void main() {
  test('reads the Gateway stats and sums a reading over the period', () {
    final stats = DeviceStats.fromJson(_json(), StatsRange.day);
    expect(stats.hourly, isTrue);
    expect(stats.buckets, hasLength(3));
    expect(stats.alertsOnly, isTrue);
    expect(stats.events.items.single.label, 'Khói vượt ngưỡng');
    expect(stats.commands.total, 0);

    final temperature = stats.measures.first;
    expect(temperature.points[1], isNull);
    expect(temperature.average, closeTo(28.875, 1e-9));
    expect(temperature.lowest, 26);
    expect(temperature.highest, 32);
    expect(temperature.format(28.875), '28,9°C');
    expect(stats.measures.last.hasData, isFalse);
    expect(stats.measures.last.format(-61), '-61 dBm');
  });

  test('labels hours and days in Vietnam time', () {
    final start = DateTime.parse('2026-11-22T07:00:00Z'); // 14:00 in Hà Nội
    expect(bucketLabel(start, hourly: true), '14:00–15:00, 22/11');
    expect(bucketLabel(DateTime.parse('2026-11-21T17:00:00Z'), hourly: false), 'Chủ Nhật, 22/11');
    expect(StatsRange.week.period, '7 ngày qua');
  });

  testWidgets('draws a reading and a count and shows the value of a tapped hour', (tester) async {
    final stats = DeviceStats.fromJson(_json(), StatsRange.day);
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        home: Scaffold(
          body: ListView(
            children: [
              MeasureChart(measure: stats.measures.first, buckets: stats.buckets, hourly: true, period: '24 giờ qua'),
              CountChart(perBucket: stats.events.perBucket, buckets: stats.buckets, hourly: true, what: 'cảnh báo'),
            ],
          ),
        ),
      ),
    );
    expect(find.text('Nhiệt độ'), findsOneWidget);
    expect(find.textContaining('28,9°C'), findsOneWidget);
    expect(find.textContaining('Nhiều nhất lúc'), findsOneWidget);

    // Tap the left third of the reading chart: the first hour.
    final chart = find.descendant(of: find.byType(MeasureChart), matching: find.byType(CustomPaint)).first;
    final box = tester.getRect(chart);
    await tester.tapAt(Offset(box.right - box.width * 0.9, box.center.dy));
    await tester.pump();
    expect(find.textContaining('14:00–15:00, 22/11'), findsOneWidget);
    expect(find.textContaining('30,5°C'), findsOneWidget);
  });
}
