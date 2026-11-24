import 'package:dio/dio.dart';

/// The periods a chart can show; hours for a day, days for a week or a month.
enum StatsRange {
  day('24h', '24 giờ'),
  week('7d', '7 ngày'),
  month('30d', '30 ngày');

  const StatsRange(this.apiValue, this.label);

  final String apiValue;
  final String label;

  /// "24 giờ qua", "7 ngày qua".
  String get period => '$label qua';

  /// The period of an API value ('24h', '7d', '30d'), null when unknown.
  static StatsRange? fromApi(String? value) {
    for (final range in values) {
      if (range.apiValue == value) return range;
    }
    return null;
  }
}

/// The Gateway cuts hours and days in Vietnam time (UTC+7, no daylight saving),
/// so labels use that clock whatever the phone's time zone.
DateTime vietnamTime(DateTime instant) => instant.toUtc().add(const Duration(hours: 7));

double _number(Object? value) => (value as num?)?.toDouble() ?? 0;

/// Average, lowest and highest reading within one hour or day.
class StatsPoint {
  const StatsPoint({required this.avg, required this.min, required this.max});

  factory StatsPoint.fromJson(Map<String, dynamic> json) => StatsPoint(
        avg: _number(json['avg']),
        min: _number(json['min']),
        max: _number(json['max']),
      );

  final double avg;
  final double min;
  final double max;
}

/// One sampled reading (temperature, gas level, Wi-Fi signal...) over the period.
class StatsMeasure {
  const StatsMeasure({
    required this.property,
    required this.label,
    required this.unit,
    required this.minimum,
    required this.maximum,
    required this.precision,
    required this.points,
  });

  factory StatsMeasure.fromJson(Map<String, dynamic> json) => StatsMeasure(
        property: json['property'] as String? ?? '',
        label: json['label'] as String? ?? '',
        unit: json['unit'] as String?,
        minimum: (json['minimum'] as num?)?.toDouble(),
        maximum: (json['maximum'] as num?)?.toDouble(),
        precision: (json['precision'] as num?)?.toInt() ?? 1,
        points: [
          for (final point in json['points'] as List? ?? const [])
            point is Map<String, dynamic> ? StatsPoint.fromJson(point) : null,
        ],
      );

  final String property;
  /// What is measured, from the catalog ("Nhiệt độ", "Mức khí gas").
  final String label;
  final String? unit;
  final double? minimum;
  final double? maximum;
  final int precision;

  /// One entry per bucket; null where the device sent no reading.
  final List<StatsPoint?> points;

  Iterable<StatsPoint> get _present => points.whereType<StatsPoint>();

  bool get hasData => _present.isNotEmpty;

  /// Mean of the hourly (daily) averages over the period.
  double? get average {
    final values = _present.map((point) => point.avg).toList();
    if (values.isEmpty) return null;
    return values.reduce((a, b) => a + b) / values.length;
  }

  double? get lowest => hasData ? _present.map((point) => point.min).reduce((a, b) => a < b ? a : b) : null;

  double? get highest => hasData ? _present.map((point) => point.max).reduce((a, b) => a > b ? a : b) : null;

  /// A reading with its unit: "31,5°C", "-60 dBm", "42%".
  String format(double value) {
    final digits = precision < 0 ? 0 : (precision > 3 ? 3 : precision);
    final fixed = value.toStringAsFixed(digits).replaceAll('.', ',');
    return switch (unit) {
      'celsius' => '$fixed°C',
      'percent' => '$fixed%',
      'normalized' => '$fixed/100',
      'degree' => '$fixed°',
      'dbm' => '$fixed dBm',
      null || '' => fixed,
      final other => '$fixed $other',
    };
  }
}

class StatsCount {
  const StatsCount({required this.key, required this.label, required this.count});

  final String key;
  final String label;
  final int count;
}

/// How many times something happened: per bucket and per kind.
class StatsCounts {
  const StatsCounts({required this.total, required this.perBucket, required this.items});

  factory StatsCounts.fromJson(Map<String, dynamic>? json, String listKey, String itemKey) => StatsCounts(
        total: (json?['total'] as num?)?.toInt() ?? 0,
        perBucket: [for (final value in json?['per_bucket'] as List? ?? const []) (value as num?)?.toInt() ?? 0],
        items: [
          for (final item in json?[listKey] as List? ?? const [])
            if (item is Map<String, dynamic>)
              StatsCount(
                key: item[itemKey] as String? ?? '',
                label: item['label'] as String? ?? '',
                count: (item['count'] as num?)?.toInt() ?? 0,
              ),
        ],
      );

  final int total;
  final List<int> perBucket;

  /// Most frequent first.
  final List<StatsCount> items;
}

class DeviceStats {
  const DeviceStats({
    required this.range,
    required this.hourly,
    required this.buckets,
    required this.since,
    required this.measures,
    required this.events,
    required this.alertsOnly,
    required this.commands,
    required this.generatedAt,
  });

  factory DeviceStats.fromJson(Map<String, dynamic> json, StatsRange range) {
    final events = json['events'] as Map<String, dynamic>?;
    return DeviceStats(
      range: range,
      hourly: json['unit'] == 'hour',
      buckets: [
        for (final value in json['buckets'] as List? ?? const [])
          if (value is String && DateTime.tryParse(value) != null) DateTime.parse(value),
      ],
      since: json['since'] is String ? DateTime.tryParse(json['since'] as String) : null,
      measures: [
        for (final item in json['measures'] as List? ?? const [])
          if (item is Map<String, dynamic>) StatsMeasure.fromJson(item),
      ],
      events: StatsCounts.fromJson(events, 'by_name', 'event_name'),
      alertsOnly: events?['scope'] == 'alerts',
      commands: StatsCounts.fromJson(json['commands'] as Map<String, dynamic>?, 'by_operation', 'operation'),
      generatedAt: DateTime.tryParse(json['generated_at'] as String? ?? '') ?? DateTime.now(),
    );
  }

  final StatsRange range;

  /// Buckets are hours (24 giờ) rather than days.
  final bool hourly;

  /// Start of each bucket.
  final List<DateTime> buckets;

  /// Set when the viewer got the device during the period: nothing before it is shown.
  final DateTime? since;
  final List<StatsMeasure> measures;
  final StatsCounts events;

  /// Members count warnings and alerts only, like in "Thông báo".
  final bool alertsOnly;
  final StatsCounts commands;

  /// The Gateway keeps the numbers a few minutes; this is when they were counted.
  final DateTime generatedAt;
}

/// `GET /devices/:mac/stats` — numbers for "Biểu đồ hoạt động".
class DeviceStatsApi {
  const DeviceStatsApi(this._dio);

  final Dio _dio;

  Future<DeviceStats> fetch(String mac, StatsRange range) async {
    final response = await _dio.get<Map<String, dynamic>>(
      '/devices/${Uri.encodeComponent(mac.trim().toUpperCase())}/stats',
      queryParameters: {'range': range.apiValue},
    );
    return DeviceStats.fromJson(response.data?['stats'] as Map<String, dynamic>? ?? const {}, range);
  }
}
