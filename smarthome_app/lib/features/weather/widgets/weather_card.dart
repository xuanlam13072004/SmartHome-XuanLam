import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons/lucide_icons.dart';

import '../../../core/core.dart';
import '../../../core/navigation/app_routes.dart';
import '../../../core/widgets/widgets.dart';
import '../providers/weather_providers.dart';
import '../weather_labels.dart';

/// "Tổng quan": the weather at home in one line, or an invitation to set the
/// home location. Nothing when the server has no weather or cannot be reached.
class WeatherCard extends ConsumerWidget {
  const WeatherCard({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final home = ref.watch(homeWeatherProvider).valueOrNull;
    if (home == null || !home.enabled) return const SizedBox.shrink();
    final scheme = context.colorScheme;
    final location = home.location;
    final weather = home.weather;

    final IconData icon;
    final String title;
    final String subtitle;
    if (location == null) {
      icon = LucideIcons.mapPin;
      title = 'Đặt vị trí nhà để xem thời tiết';
      subtitle = 'Dùng cho tự động hóa theo mưa, nắng và để hỏi trợ lý';
    } else if (weather == null) {
      icon = LucideIcons.cloud;
      title = location.place;
      subtitle = 'Đang lấy dự báo thời tiết…';
    } else {
      icon = WeatherLabels.icon(weather);
      title = '${location.place} · ${WeatherLabels.now(weather)}';
      subtitle = [
        if (WeatherLabels.today(weather) != null) WeatherLabels.today(weather)!,
        weather.rainText,
        if (weather.isMock) 'giả lập',
      ].join(' · ');
    }

    return Padding(
      padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.md, AppSpacing.md, 0),
      child: Semantics(
        button: true,
        label: '$title. $subtitle',
        excludeSemantics: true,
        child: GestureDetector(
          onTap: () => context.push(AppRoutes.profileHomeLocation),
          child: NeuCard(
            padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md, vertical: AppSpacing.smMd),
            child: Row(
              children: [
                Icon(icon, color: weather?.raining == true ? scheme.primary : scheme.onSurfaceVariant),
                const SizedBox(width: AppSpacing.smMd),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: context.textTheme.titleSmall),
                      Text(
                        subtitle,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: context.textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant),
                      ),
                    ],
                  ),
                ),
                Icon(LucideIcons.chevronRight, size: 18, color: scheme.onSurfaceVariant),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
