import 'package:flutter/widgets.dart';
import 'package:lucide_icons/lucide_icons.dart';

import 'data/weather_models.dart';

/// Icons and words of the weather at home.
abstract final class WeatherLabels {
  /// An icon for the sky now ("Mưa", "Nhiều mây", "Trời quang"…).
  static IconData icon(WeatherSummary weather) {
    if (weather.raining) return LucideIcons.cloudRain;
    return switch (weather.description) {
      'Dông' => LucideIcons.cloudLightning,
      'Mưa to' || 'Mưa' || 'Mưa rào' => LucideIcons.cloudRain,
      'Mưa phùn' => LucideIcons.cloudDrizzle,
      'Sương mù' => LucideIcons.cloudFog,
      'Nhiều mây' => LucideIcons.cloud,
      'Ít mây' => LucideIcons.cloudSun,
      _ => LucideIcons.sun,
    };
  }

  /// "31°C · Ít mây".
  static String now(WeatherSummary weather) => [
        if (weather.temperature != null) '${weather.temperature}°C',
        if (weather.description != null) weather.description!,
      ].join(' · ');

  /// "Hôm nay 25–32°C".
  static String? today(WeatherSummary weather) =>
      weather.todayMin == null || weather.todayMax == null ? null : 'Hôm nay ${weather.todayMin}–${weather.todayMax}°C';

  /// The rule an automation's "có mưa" uses, shown where it matters.
  static const rainRule = 'Một giờ được tính là có mưa khi dự báo khả năng mưa từ 50% hoặc lượng mưa từ 0,5 mm.';
}
