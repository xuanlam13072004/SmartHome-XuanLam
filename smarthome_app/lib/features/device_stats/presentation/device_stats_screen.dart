// Hallmark · device charts · period first → readings → what happened → what was commanded
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/core.dart';
import '../../../core/widgets/widgets.dart';
import '../../dashboard/providers/devices_provider.dart';
import '../../products/widgets/product_page_kit.dart';
import '../data/device_stats.dart';
import '../providers/device_stats_provider.dart';
import '../widgets/stats_charts.dart';

String _two(int value) => value.toString().padLeft(2, '0');

String _clock(DateTime instant) {
  final time = vietnamTime(instant);
  return '${_two(time.hour)}:${_two(time.minute)}';
}

/// "Biểu đồ hoạt động" of one device: readings, events and commands over
/// the last 24 hours, 7 or 30 days.
class DeviceStatsScreen extends ConsumerStatefulWidget {
  const DeviceStatsScreen({super.key, required this.mac, this.initialRange});

  final String mac;

  /// The period shown first (24 hours when not given).
  final StatsRange? initialRange;

  @override
  ConsumerState<DeviceStatsScreen> createState() => _DeviceStatsScreenState();
}

class _DeviceStatsScreenState extends ConsumerState<DeviceStatsScreen> {
  late StatsRange _range = widget.initialRange ?? StatsRange.day;

  /// The last numbers shown, kept (dimmed) while another period loads.
  DeviceStats? _previous;

  @override
  Widget build(BuildContext context) {
    final mac = widget.mac.trim().toUpperCase();
    final key = (mac: mac, range: _range);
    final stats = ref.watch(deviceStatsProvider(key));
    final current = stats.valueOrNull;
    if (current != null) _previous = current;
    final shown = current ?? _previous;
    final devices = ref.watch(devicesProvider).valueOrNull ?? const [];
    String? name;
    for (final device in devices) {
      if (device.mac == mac) name = device.name;
    }

    return PageScaffold(
      appBar: AppBar(
        leading: IconButton(icon: const Icon(Icons.arrow_back), onPressed: () => context.pop()),
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Biểu đồ hoạt động'),
            if (name != null)
              Text(
                name,
                style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant),
              ),
          ],
        ),
      ),
      scrollable: false,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.sm, AppSpacing.md, AppSpacing.xl),
        children: [
          Wrap(
            spacing: AppSpacing.sm,
            children: [
              for (final range in StatsRange.values)
                NeuChip(
                  label: range.label,
                  isSelected: range == _range,
                  onSelected: (_) => setState(() => _range = range),
                ),
            ],
          ),
          const SizedBox(height: AppSpacing.md),
          if (stats.hasError && !stats.isLoading)
            NeuCard(
              child: _Message(
                icon: Icons.insights_rounded,
                text: 'Chưa tải được biểu đồ. Vui lòng thử lại.',
                action: TextButton(
                  onPressed: () => ref.invalidate(deviceStatsProvider(key)),
                  child: const Text('Thử lại'),
                ),
              ),
            )
          else if (shown == null)
            const Padding(
              padding: EdgeInsets.all(AppSpacing.xl),
              child: Center(child: CircularProgressIndicator()),
            )
          else
            AnimatedOpacity(
              duration: const Duration(milliseconds: 150),
              opacity: current == null ? 0.5 : 1,
              child: _StatsBody(stats: shown),
            ),
        ],
      ),
    );
  }
}

class _StatsBody extends StatelessWidget {
  const _StatsBody({required this.stats});

  final DeviceStats stats;

  @override
  Widget build(BuildContext context) {
    final period = stats.range.period;
    final since = stats.since;
    final measures = stats.measures.where((measure) => measure.hasData).toList();
    final muted = context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (since != null) ...[
          _Note(
            'Bạn có thiết bị này từ ${_clock(since)} ngày ${vietnamTime(since).day}/${vietnamTime(since).month}, '
            'nên chỉ thấy số liệu từ lúc đó.',
          ),
          const SizedBox(height: AppSpacing.md),
        ],
        if (stats.measures.isNotEmpty) ...[
          ProductSection(
            title: 'Số đo',
            child: measures.isEmpty
                ? NeuCard(
                    child: _Message(icon: Icons.show_chart_rounded, text: 'Thiết bị chưa gửi số đo nào trong $period.'),
                  )
                : Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      for (var index = 0; index < measures.length; index++) ...[
                        if (index > 0) const SizedBox(height: AppSpacing.md),
                        NeuCard(
                          child: MeasureChart(
                            measure: measures[index],
                            buckets: stats.buckets,
                            hourly: stats.hourly,
                            period: period,
                          ),
                        ),
                      ],
                    ],
                  ),
          ),
          const SizedBox(height: AppSpacing.lg),
        ],
        _CountSection(
          title: stats.alertsOnly ? 'Cảnh báo' : 'Sự kiện',
          what: stats.alertsOnly ? 'cảnh báo' : 'sự kiện',
          counts: stats.events,
          stats: stats,
          note: stats.alertsOnly ? 'Thành viên được chia sẻ chỉ thấy cảnh báo, giống mục Thông báo.' : null,
        ),
        const SizedBox(height: AppSpacing.lg),
        _CountSection(title: 'Lệnh điều khiển', what: 'lệnh', counts: stats.commands, stats: stats),
        const SizedBox(height: AppSpacing.md),
        Text('Số liệu tính lúc ${_clock(stats.generatedAt)} và làm mới sau vài phút.', style: muted),
      ],
    );
  }
}

/// Total, a column per hour (day) and the most frequent kinds.
class _CountSection extends StatelessWidget {
  const _CountSection({
    required this.title,
    required this.what,
    required this.counts,
    required this.stats,
    this.note,
  });

  final String title;
  final String what;
  final StatsCounts counts;
  final DeviceStats stats;
  final String? note;

  static const _shownKinds = 5;

  @override
  Widget build(BuildContext context) {
    final muted = context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant);
    final kinds = counts.items.take(_shownKinds).toList();
    final others = counts.items.skip(_shownKinds).fold<int>(0, (sum, item) => sum + item.count);
    return ProductSection(
      title: title,
      child: NeuCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.baseline,
              textBaseline: TextBaseline.alphabetic,
              children: [
                Text('${counts.total}', style: context.textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w700)),
                const SizedBox(width: AppSpacing.sm),
                Expanded(child: Text('$what trong ${stats.range.period}', style: muted)),
              ],
            ),
            if (counts.total > 0) ...[
              const SizedBox(height: AppSpacing.sm),
              CountChart(perBucket: counts.perBucket, buckets: stats.buckets, hourly: stats.hourly, what: what),
              const SizedBox(height: AppSpacing.sm),
              for (final kind in kinds) _KindRow(label: kind.label, count: kind.count),
              if (others > 0) _KindRow(label: 'Loại khác', count: others),
            ],
            if (note != null) ...[
              const SizedBox(height: AppSpacing.sm),
              Text(note!, style: muted),
            ],
          ],
        ),
      ),
    );
  }
}

class _KindRow extends StatelessWidget {
  const _KindRow({required this.label, required this.count});

  final String label;
  final int count;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: AppSpacing.xs),
        child: Row(
          children: [
            Expanded(child: Text(label, style: context.textTheme.bodyMedium)),
            Text(
              '$count lần',
              style: context.textTheme.bodyMedium?.copyWith(
                fontWeight: FontWeight.w600,
                fontFeatures: const [FontFeature.tabularFigures()],
              ),
            ),
          ],
        ),
      );
}

class _Note extends StatelessWidget {
  const _Note(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.info_outline_rounded, size: 18, color: context.colorScheme.onSurfaceVariant),
          const SizedBox(width: AppSpacing.sm),
          Expanded(
            child: Text(
              text,
              style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant),
            ),
          ),
        ],
      );
}

class _Message extends StatelessWidget {
  const _Message({required this.icon, required this.text, this.action});

  final IconData icon;
  final String text;
  final Widget? action;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: AppSpacing.md),
        child: Column(
          children: [
            Icon(icon, size: 32, color: context.colorScheme.onSurfaceVariant),
            const SizedBox(height: AppSpacing.sm),
            Text(text, textAlign: TextAlign.center, style: context.textTheme.bodyMedium),
            if (action != null) ...[const SizedBox(height: AppSpacing.xs), action!],
          ],
        ),
      );
}
