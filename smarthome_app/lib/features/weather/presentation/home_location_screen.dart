import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../core/core.dart';
import '../../../core/utils/app_error_mapper.dart';
import '../../../core/utils/time_format.dart';
import '../../../core/widgets/widgets.dart';
import '../../automations/providers/automations_providers.dart';
import '../../profile/widgets/confirm_dialog.dart';
import '../data/weather_models.dart';
import '../providers/weather_providers.dart';
import '../weather_labels.dart';

/// "Vị trí nhà & thời tiết": where the home is (one of 63 areas, the provinces
/// before the 2025 merger; never the phone's GPS) and the forecast automations
/// and the assistant read.
class HomeLocationScreen extends ConsumerStatefulWidget {
  const HomeLocationScreen({super.key});

  @override
  ConsumerState<HomeLocationScreen> createState() => _HomeLocationScreenState();
}

class _HomeLocationScreenState extends ConsumerState<HomeLocationScreen> {
  bool _saving = false;

  /// Runs [action]; its result is the message shown when it is done.
  Future<void> _run(Future<String> Function() action) async {
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _saving = true);
    try {
      final done = await action();
      ref.invalidate(homeWeatherProvider);
      ref.invalidate(automationOptionsProvider);
      ref.invalidate(automationSuggestionsProvider);
      messenger.showSnackBar(SnackBar(content: Text(done)));
    } catch (error) {
      messenger.showSnackBar(SnackBar(content: Text(AppErrorMapper.mapError(error))));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _pickArea(HomeLocation? current) async {
    final area = await showModalBottomSheet<WeatherArea>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      useRootNavigator: true,
      builder: (_) => _AreaSheet(current: current?.area),
    );
    if (area == null || !mounted) return;
    await _run(() async {
      final location = await ref.read(weatherApiProvider).setArea(area.code);
      return 'Đã đặt vị trí nhà: ${location.place}';
    });
  }

  Future<void> _clear() async {
    final confirmed = await confirmAction(
      context,
      title: 'Xóa vị trí nhà?',
      message: 'Ứng dụng sẽ không xem được thời tiết. Tự động hóa có điều kiện thời tiết sẽ không chạy cho đến khi bạn đặt lại.',
      confirmLabel: 'Xóa',
      destructive: true,
    );
    if (!confirmed || !mounted) return;
    await _run(() async {
      await ref.read(weatherApiProvider).clearLocation();
      return 'Đã xóa vị trí nhà';
    });
  }

  Future<void> _open(Uri url) async {
    final messenger = ScaffoldMessenger.of(context);
    final opened = await launchUrl(url, mode: LaunchMode.externalApplication).catchError((_) => false);
    if (!opened) messenger.showSnackBar(SnackBar(content: Text('Không mở được ${url.host}')));
  }

  @override
  Widget build(BuildContext context) {
    final home = ref.watch(homeWeatherProvider);
    final scheme = context.colorScheme;
    final muted = context.textTheme.bodyMedium?.copyWith(color: scheme.onSurfaceVariant);

    return PageScaffold(
      scrollable: false,
      appBar: AppBar(title: const Text('Vị trí nhà & thời tiết')),
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
      child: RefreshIndicator(
        onRefresh: () async {
          ref.invalidate(homeWeatherProvider);
          try {
            await ref.read(homeWeatherProvider.future);
          } catch (_) {}
        },
        child: home.when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (error, _) => ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            children: [
              EmptyState(
                icon: LucideIcons.alertTriangle,
                title: 'Không tải được thời tiết',
                description: AppErrorMapper.mapError(error),
                actionText: 'Thử lại',
                onActionTap: () => ref.invalidate(homeWeatherProvider),
              ),
            ],
          ),
          data: (data) => ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.only(top: AppSpacing.sm, bottom: 120),
            children: [
              if (!data.enabled)
                const EmptyState(
                  icon: LucideIcons.cloudOff,
                  title: 'Chưa có thời tiết',
                  description: 'Máy chủ chưa bật tính năng thời tiết.',
                )
              else ...[
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm),
                  child: Text(
                    'Đặt nơi có nhà để tự động hóa chạy theo mưa, nắng và để hỏi trợ lý về thời tiết. '
                    'Chọn tỉnh/thành phố rồi chọn khu vực theo tỉnh, thành cũ; dự báo lấy ở trung tâm khu vực. '
                    'Ứng dụng không dùng GPS.',
                    style: muted,
                  ),
                ),
                const SizedBox(height: AppSpacing.md),
                _CurrentCard(home: data, busy: _saving, onClear: _clear),
                const SectionTitle(title: 'Khu vực của nhà'),
                NeuCard(
                  padding: EdgeInsets.zero,
                  child: ListTile(
                    leading: const Icon(LucideIcons.map),
                    title: Text(data.location == null ? 'Chọn khu vực' : 'Đổi khu vực'),
                    subtitle: const Text('34 tỉnh, thành phố · 63 khu vực theo tỉnh, thành cũ'),
                    trailing: const Icon(LucideIcons.chevronRight),
                    enabled: !_saving,
                    onTap: () => _pickArea(data.location),
                  ),
                ),
                const SizedBox(height: AppSpacing.lg),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm),
                  child: Text(WeatherLabels.rainRule, style: context.textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant)),
                ),
                if (data.attribution != null) ...[
                  const SizedBox(height: AppSpacing.xs),
                  _Attribution(attribution: data.attribution!, onOpen: _open),
                ],
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// The home now: its name, the forecast and "Xóa".
class _CurrentCard extends StatelessWidget {
  const _CurrentCard({required this.home, required this.busy, required this.onClear});

  final HomeWeather home;
  final bool busy;
  final VoidCallback onClear;

  @override
  Widget build(BuildContext context) {
    final scheme = context.colorScheme;
    final location = home.location;
    final weather = home.weather;
    if (location == null) {
      return NeuCard(
        child: Row(
          children: [
            Icon(LucideIcons.mapPinOff, color: scheme.onSurfaceVariant),
            const SizedBox(width: AppSpacing.smMd),
            const Expanded(child: Text('Chưa đặt vị trí nhà. Chọn khu vực bên dưới.')),
          ],
        ),
      );
    }
    return NeuCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(LucideIcons.mapPin, color: scheme.primary),
              const SizedBox(width: AppSpacing.sm),
              Expanded(child: Text(location.place, style: context.textTheme.titleMedium)),
              TextButton(onPressed: busy ? null : onClear, child: const Text('Xóa')),
            ],
          ),
          const SizedBox(height: AppSpacing.sm),
          if (weather == null)
            Text('Chưa có dự báo cho khu vực này, kéo xuống để tải lại sau ít phút.',
                style: context.textTheme.bodyMedium?.copyWith(color: scheme.onSurfaceVariant))
          else ...[
            Row(
              children: [
                Icon(WeatherLabels.icon(weather), size: 36, color: weather.raining ? scheme.primary : scheme.onSurface),
                const SizedBox(width: AppSpacing.smMd),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(WeatherLabels.now(weather), style: context.textTheme.titleLarge),
                      Text(
                        [if (WeatherLabels.today(weather) != null) WeatherLabels.today(weather)!, weather.rainText].join(' · '),
                        style: context.textTheme.bodyMedium?.copyWith(color: scheme.onSurfaceVariant),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            if (weather.nextHours.isNotEmpty) ...[
              const SizedBox(height: AppSpacing.md),
              SizedBox(
                height: 72,
                child: ListView.separated(
                  scrollDirection: Axis.horizontal,
                  itemCount: weather.nextHours.length,
                  separatorBuilder: (_, __) => const SizedBox(width: AppSpacing.md),
                  itemBuilder: (_, index) {
                    final hour = weather.nextHours[index];
                    return Semantics(
                      label: '${hour.at.hour} giờ, ${hour.temperature ?? '?'} độ${hour.rain ? ', có mưa' : ''}',
                      excludeSemantics: true,
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Text('${hour.at.hour}h', style: context.textTheme.labelSmall?.copyWith(color: scheme.onSurfaceVariant)),
                          Icon(hour.rain ? LucideIcons.cloudRain : LucideIcons.cloud,
                              size: 18, color: hour.rain ? scheme.primary : scheme.onSurfaceVariant),
                          Text(hour.temperature == null ? '–' : '${hour.temperature}°', style: context.textTheme.labelMedium),
                        ],
                      ),
                    );
                  },
                ),
              ),
            ],
            const SizedBox(height: AppSpacing.sm),
            Text(
              [
                if (weather.updatedAt != null) 'Cập nhật ${TimeFormat.clock(weather.updatedAt!)}',
                if (weather.isMock) 'Thời tiết giả lập để thử nghiệm',
              ].join(' · '),
              style: context.textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant),
            ),
          ],
        ],
      ),
    );
  }
}

/// The source of the data; Open-Meteo's (CC BY 4.0) opens its site when tapped.
class _Attribution extends StatelessWidget {
  const _Attribution({required this.attribution, required this.onOpen});

  final WeatherAttribution attribution;
  final ValueChanged<Uri> onOpen;

  @override
  Widget build(BuildContext context) {
    final scheme = context.colorScheme;
    final url = attribution.url;
    final style = context.textTheme.bodySmall?.copyWith(color: url == null ? scheme.onSurfaceVariant : scheme.primary);
    if (url == null) {
      return Padding(
        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm),
        child: Text(attribution.text, style: style),
      );
    }
    return Semantics(
      link: true,
      child: InkWell(
        onTap: () => onOpen(url),
        borderRadius: BorderRadius.circular(AppSpacing.xs),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm, vertical: AppSpacing.xs),
          child: Row(
            children: [
              Flexible(child: Text(attribution.text, style: style?.copyWith(decoration: TextDecoration.underline))),
              const SizedBox(width: AppSpacing.xs),
              Icon(LucideIcons.externalLink, size: 14, color: scheme.primary),
            ],
          ),
        ),
      ),
    );
  }
}

/// Picks the home's area: the 34 provinces (filtered as the user types, old
/// names included), then, for a merged province, one of its areas.
class _AreaSheet extends ConsumerStatefulWidget {
  const _AreaSheet({required this.current});

  /// The home's area now, marked in the lists.
  final String? current;

  @override
  ConsumerState<_AreaSheet> createState() => _AreaSheetState();
}

class _AreaSheetState extends ConsumerState<_AreaSheet> {
  String _filter = '';

  /// The merged province whose areas are shown (null: the province list).
  Province? _province;

  static String _fold(String text) {
    const from = 'àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ';
    const to = 'aaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyyd';
    final lower = text.toLowerCase();
    final buffer = StringBuffer();
    for (final rune in lower.runes) {
      final char = String.fromCharCode(rune);
      final index = from.indexOf(char);
      buffer.write(index >= 0 ? to[index] : char);
    }
    return buffer.toString();
  }

  bool _matches(Province province) =>
      _filter.isEmpty ||
      _fold(province.name).contains(_filter) ||
      province.areas.any((area) => _fold(area.name).contains(_filter));

  void _choose(Province province) {
    if (province.merged) {
      setState(() => _province = province);
    } else if (province.areas.isNotEmpty) {
      Navigator.of(context).pop(province.areas.first);
    }
  }

  Widget? _mark(bool current) =>
      current ? Icon(LucideIcons.check, color: context.colorScheme.primary) : null;

  @override
  Widget build(BuildContext context) {
    final provinces = ref.watch(provincesProvider);
    final muted = context.textTheme.bodyMedium?.copyWith(color: context.colorScheme.onSurfaceVariant);
    final province = _province;
    return ConstrainedBox(
      constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.85),
      child: Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
        child: province != null
            ? Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Padding(
                    padding: const EdgeInsets.fromLTRB(AppSpacing.sm, 0, AppSpacing.lg, AppSpacing.xs),
                    child: Row(
                      children: [
                        IconButton(
                          tooltip: 'Quay lại danh sách tỉnh',
                          icon: const Icon(LucideIcons.arrowLeft),
                          onPressed: () => setState(() => _province = null),
                        ),
                        Expanded(child: Text(province.name, style: context.textTheme.titleLarge)),
                      ],
                    ),
                  ),
                  Padding(
                    padding: const EdgeInsets.fromLTRB(AppSpacing.lg, 0, AppSpacing.lg, AppSpacing.sm),
                    child: Text('Tỉnh này gồm ${province.areas.length} tỉnh, thành cũ. Chọn nơi gần nhà nhất.', style: muted),
                  ),
                  Flexible(
                    child: ListView(
                      shrinkWrap: true,
                      padding: const EdgeInsets.only(bottom: AppSpacing.lg),
                      children: [
                        for (final area in province.areas)
                          ListTile(
                            leading: const Icon(LucideIcons.mapPin),
                            title: Text(area.name),
                            trailing: _mark(area.code == widget.current),
                            onTap: () => Navigator.of(context).pop(area),
                          ),
                      ],
                    ),
                  ),
                ],
              )
            : Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Padding(
                    padding: const EdgeInsets.fromLTRB(AppSpacing.lg, 0, AppSpacing.lg, AppSpacing.sm),
                    child: Text('Tỉnh/thành phố', style: context.textTheme.titleLarge),
                  ),
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
                    child: TextField(
                      decoration: const InputDecoration(
                        prefixIcon: Icon(LucideIcons.search),
                        hintText: 'Lọc theo tên, cả tên tỉnh cũ',
                        border: OutlineInputBorder(),
                      ),
                      onChanged: (value) => setState(() => _filter = _fold(value.trim())),
                    ),
                  ),
                  const SizedBox(height: AppSpacing.sm),
                  Flexible(
                    child: provinces.when(
                      loading: () => const Padding(
                        padding: EdgeInsets.all(AppSpacing.xl),
                        child: Center(child: CircularProgressIndicator()),
                      ),
                      error: (error, _) => Padding(
                        padding: const EdgeInsets.all(AppSpacing.lg),
                        child: Text(AppErrorMapper.mapError(error)),
                      ),
                      data: (items) {
                        final shown = items.where(_matches).toList();
                        if (shown.isEmpty) {
                          return Padding(
                            padding: const EdgeInsets.all(AppSpacing.lg),
                            child: Text('Không có tỉnh, thành phố nào có tên này.', style: muted),
                          );
                        }
                        return ListView(
                          shrinkWrap: true,
                          padding: const EdgeInsets.only(bottom: AppSpacing.lg),
                          children: [
                            for (final item in shown)
                              ListTile(
                                title: Text(item.name),
                                subtitle: item.merged ? Text(item.areas.map((area) => area.name).join(' · ')) : null,
                                trailing: item.merged
                                    ? const Icon(LucideIcons.chevronRight)
                                    : _mark(item.areas.any((area) => area.code == widget.current)),
                                onTap: () => _choose(item),
                              ),
                          ],
                        );
                      },
                    ),
                  ),
                ],
              ),
      ),
    );
  }
}
