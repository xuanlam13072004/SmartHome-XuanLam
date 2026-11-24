import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons/lucide_icons.dart';

import '../../../core/core.dart';
import '../../../core/utils/app_error_mapper.dart';
import '../../../core/utils/time_format.dart';
import '../../../core/widgets/widgets.dart';
import '../../automations/providers/automations_providers.dart';
import '../../profile/widgets/confirm_dialog.dart';
import '../data/weather_models.dart';
import '../providers/weather_providers.dart';
import '../weather_labels.dart';

/// "Vị trí nhà & thời tiết": where the home is (a province or a ward found by
/// name, never the phone's GPS) and the forecast automations and the assistant read.
class HomeLocationScreen extends ConsumerStatefulWidget {
  const HomeLocationScreen({super.key});

  @override
  ConsumerState<HomeLocationScreen> createState() => _HomeLocationScreenState();
}

class _HomeLocationScreenState extends ConsumerState<HomeLocationScreen> {
  final _query = TextEditingController();
  List<PlaceResult>? _places;
  bool _searching = false;
  bool _saving = false;
  String? _searchError;

  @override
  void dispose() {
    _query.dispose();
    super.dispose();
  }

  Future<void> _run(Future<void> Function() action, String done) async {
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _saving = true);
    try {
      await action();
      ref.invalidate(homeWeatherProvider);
      ref.invalidate(automationOptionsProvider);
      ref.invalidate(automationSuggestionsProvider);
      messenger.showSnackBar(SnackBar(content: Text(done)));
      if (mounted) setState(() => _places = null);
    } catch (error) {
      messenger.showSnackBar(SnackBar(content: Text(AppErrorMapper.mapError(error))));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _search() async {
    final query = _query.text.trim();
    if (query.length < 2) {
      setState(() => _searchError = 'Nhập ít nhất 2 chữ');
      return;
    }
    FocusScope.of(context).unfocus();
    setState(() {
      _searching = true;
      _searchError = null;
    });
    try {
      final places = await ref.read(weatherApiProvider).searchPlaces(query);
      if (mounted) setState(() => _places = places);
    } catch (error) {
      if (mounted) setState(() => _searchError = AppErrorMapper.mapError(error));
    } finally {
      if (mounted) setState(() => _searching = false);
    }
  }

  Future<void> _pickProvince() async {
    final province = await showModalBottomSheet<Province>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      useRootNavigator: true,
      builder: (_) => const _ProvinceSheet(),
    );
    if (province == null || !mounted) return;
    await _run(() => ref.read(weatherApiProvider).setProvince(province.code), 'Đã đặt vị trí nhà: ${province.name}');
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
    await _run(() => ref.read(weatherApiProvider).clearLocation(), 'Đã xóa vị trí nhà');
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
                    'Chỉ cần vị trí gần đúng (tỉnh/thành phố hoặc phường/xã); ứng dụng không dùng GPS.',
                    style: muted,
                  ),
                ),
                const SizedBox(height: AppSpacing.md),
                _CurrentCard(home: data, busy: _saving, onClear: _clear),
                const SectionTitle(title: 'Chọn tỉnh/thành phố'),
                NeuCard(
                  padding: EdgeInsets.zero,
                  child: ListTile(
                    leading: const Icon(LucideIcons.map),
                    title: const Text('34 tỉnh, thành phố'),
                    subtitle: const Text('Dùng dự báo ở trung tâm tỉnh'),
                    trailing: const Icon(LucideIcons.chevronRight),
                    enabled: !_saving,
                    onTap: _pickProvince,
                  ),
                ),
                const SectionTitle(title: 'Hoặc tìm phường, xã'),
                TextField(
                  controller: _query,
                  enabled: !_saving,
                  textInputAction: TextInputAction.search,
                  maxLength: 60,
                  decoration: InputDecoration(
                    hintText: 'Ví dụ: Ba Đình, Hòa Khánh',
                    counterText: '',
                    errorText: _searchError,
                    border: const OutlineInputBorder(),
                    suffixIcon: _searching
                        ? const Padding(
                            padding: EdgeInsets.all(AppSpacing.smMd),
                            child: SizedBox.square(dimension: 20, child: CircularProgressIndicator(strokeWidth: 2)),
                          )
                        : IconButton(
                            tooltip: 'Tìm',
                            icon: const Icon(LucideIcons.search),
                            onPressed: _search,
                          ),
                  ),
                  onSubmitted: (_) => _search(),
                ),
                if (_places != null) ...[
                  const SizedBox(height: AppSpacing.sm),
                  if (_places!.isEmpty)
                    Padding(
                      padding: const EdgeInsets.all(AppSpacing.md),
                      child: Text('Không tìm thấy nơi nào. Thử tên khác hoặc chọn tỉnh/thành phố.', style: muted),
                    )
                  else
                    NeuCard(
                      padding: EdgeInsets.zero,
                      child: Column(
                        children: [
                          for (final place in _places!)
                            ListTile(
                              leading: const Icon(LucideIcons.mapPin),
                              title: Text(place.name),
                              subtitle: place.detail == null ? null : Text(place.detail!),
                              enabled: !_saving,
                              onTap: () => _run(
                                () => ref.read(weatherApiProvider).setPlace(place),
                                'Đã đặt vị trí nhà: ${place.fullName}',
                              ),
                            ),
                        ],
                      ),
                    ),
                ],
                const SizedBox(height: AppSpacing.lg),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm),
                  child: Text(WeatherLabels.rainRule, style: context.textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant)),
                ),
                if (data.attribution != null) ...[
                  const SizedBox(height: AppSpacing.xs),
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm),
                    child: Text(data.attribution!, style: context.textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant)),
                  ),
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
            const Expanded(child: Text('Chưa đặt vị trí nhà. Chọn tỉnh/thành phố hoặc tìm phường, xã bên dưới.')),
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
            Text('Đang lấy dự báo, kéo xuống để tải lại.', style: context.textTheme.bodyMedium?.copyWith(color: scheme.onSurfaceVariant))
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

/// The 34 provinces, filtered as the user types.
class _ProvinceSheet extends ConsumerStatefulWidget {
  const _ProvinceSheet();

  @override
  ConsumerState<_ProvinceSheet> createState() => _ProvinceSheetState();
}

class _ProvinceSheetState extends ConsumerState<_ProvinceSheet> {
  String _filter = '';

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

  @override
  Widget build(BuildContext context) {
    final provinces = ref.watch(provincesProvider);
    return ConstrainedBox(
      constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.85),
      child: Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
        child: Column(
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
                  hintText: 'Lọc theo tên',
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
                  final shown = items.where((item) => _filter.isEmpty || _fold(item.name).contains(_filter)).toList();
                  return ListView(
                    shrinkWrap: true,
                    padding: const EdgeInsets.only(bottom: AppSpacing.lg),
                    children: [
                      for (final province in shown)
                        ListTile(
                          title: Text(province.name),
                          onTap: () => Navigator.of(context).pop(province),
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
