/// The weather at the account's home ("Vị trí nhà & thời tiết"), as GET /weather returns it.
library;

Map<String, dynamic> _map(Object? value) =>
    value is Map ? Map<String, dynamic>.from(value) : <String, dynamic>{};

int? _int(Object? value) => value is num ? value.round() : null;

/// Where the forecast is for: a province centre or a searched place, rounded to about 1 km.
class HomeLocation {
  const HomeLocation({required this.place, required this.latitude, required this.longitude});

  final String place;
  final double latitude;
  final double longitude;

  factory HomeLocation.fromJson(Map<String, dynamic> json) => HomeLocation(
        place: json['place'] as String? ?? '',
        latitude: (json['latitude'] as num).toDouble(),
        longitude: (json['longitude'] as num).toDouble(),
      );
}

class WeatherHour {
  const WeatherHour({required this.at, required this.temperature, required this.rainChance, required this.rain});

  final DateTime at;
  final int? temperature;
  final int? rainChance;
  final bool rain;

  factory WeatherHour.fromJson(Map<String, dynamic> json) => WeatherHour(
        at: DateTime.parse(json['at'] as String).toLocal(),
        temperature: _int(json['temperature']),
        rainChance: _int(json['precipitation_probability']),
        rain: json['rain'] as bool? ?? false,
      );
}

/// Now, today and the next 12 hours.
class WeatherSummary {
  const WeatherSummary({
    required this.isMock,
    required this.updatedAt,
    required this.temperature,
    required this.raining,
    required this.description,
    required this.todayMax,
    required this.todayMin,
    required this.rainInHours,
    required this.nextHours,
  });

  final bool isMock;
  final DateTime? updatedAt;
  final int? temperature;
  final bool raining;
  final String? description;
  final int? todayMax;
  final int? todayMin;

  /// Hours until the first hour with rain (0 = now); null: no rain in 12 hours.
  final int? rainInHours;
  final List<WeatherHour> nextHours;

  factory WeatherSummary.fromJson(Map<String, dynamic> json) {
    final current = _map(json['current']);
    final today = json['today'] is Map ? _map(json['today']) : null;
    return WeatherSummary(
      isMock: json['source'] == 'mock',
      updatedAt: json['updated_at'] == null ? null : DateTime.parse(json['updated_at'] as String).toLocal(),
      temperature: _int(current['temperature']),
      raining: current['raining'] as bool? ?? false,
      description: current['description'] as String?,
      todayMax: _int(today?['max']),
      todayMin: _int(today?['min']),
      rainInHours: _int(json['rain_in_hours']),
      nextHours: (json['next_hours'] as List? ?? const [])
          .map((item) => WeatherHour.fromJson(_map(item)))
          .toList(growable: false),
    );
  }

  /// "Đang mưa", "Mưa trong khoảng 3 giờ tới", "Không mưa trong 12 giờ tới".
  String get rainText => raining || rainInHours == 0
      ? 'Đang mưa'
      : rainInHours != null
          ? 'Có thể mưa trong khoảng $rainInHours giờ tới'
          : 'Không mưa trong 12 giờ tới';
}

class HomeWeather {
  const HomeWeather({
    required this.enabled,
    required this.location,
    required this.weather,
    required this.attribution,
  });

  /// False when the server has weather turned off: nothing about it is shown.
  final bool enabled;
  final HomeLocation? location;

  /// Null while the forecast is not available yet.
  final WeatherSummary? weather;
  final String? attribution;

  factory HomeWeather.fromJson(Map<String, dynamic> json) => HomeWeather(
        enabled: json['enabled'] as bool? ?? false,
        location: json['location'] is Map ? HomeLocation.fromJson(_map(json['location'])) : null,
        weather: json['weather'] is Map ? WeatherSummary.fromJson(_map(json['weather'])) : null,
        attribution: json['attribution'] as String?,
      );
}

class Province {
  const Province({required this.code, required this.name});

  final String code;
  final String name;

  factory Province.fromJson(Map<String, dynamic> json) =>
      Province(code: json['code'] as String, name: json['name'] as String? ?? json['code'] as String);
}

/// A ward, commune or town found by name.
class PlaceResult {
  const PlaceResult({required this.name, required this.detail, required this.latitude, required this.longitude});

  final String name;
  final String? detail;
  final double latitude;
  final double longitude;

  factory PlaceResult.fromJson(Map<String, dynamic> json) => PlaceResult(
        name: json['name'] as String? ?? '',
        detail: json['detail'] as String?,
        latitude: (json['latitude'] as num).toDouble(),
        longitude: (json['longitude'] as num).toDouble(),
      );

  /// What is kept as the home's name: "Phường Ba Đình, Hà Nội".
  String get fullName {
    final area = detail?.split(',').last.trim();
    return area == null || area.isEmpty || area == name || area == 'Tỉnh/thành phố' ? name : '$name, $area';
  }
}
