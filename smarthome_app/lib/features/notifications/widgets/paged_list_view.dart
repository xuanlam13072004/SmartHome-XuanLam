import 'package:flutter/material.dart';

import '../../../core/core.dart';
import '../../../core/utils/time_format.dart';
import '../../../core/widgets/widgets.dart';
import '../providers/notification_providers.dart';

/// A day-grouped list ("Hôm nay", "Hôm qua", 06/11/2026) with "Xem thêm" at the end.
class DayGroupedPagedList<T> extends StatelessWidget {
  const DayGroupedPagedList({
    super.key,
    required this.list,
    required this.timeOf,
    required this.itemBuilder,
    required this.onLoadMore,
    required this.onRefresh,
    this.header,
  });

  final PagedList<T> list;
  final DateTime Function(T item) timeOf;
  final Widget Function(BuildContext context, T item) itemBuilder;
  final VoidCallback onLoadMore;
  final Future<void> Function() onRefresh;
  final Widget? header;

  @override
  Widget build(BuildContext context) {
    final children = <Widget>[if (header != null) header!];
    String? day;
    for (final item in list.items) {
      final label = TimeFormat.dayLabel(timeOf(item));
      if (label != day) {
        day = label;
        children.add(SectionTitle(title: label));
      }
      children.add(itemBuilder(context, item));
    }
    if (list.error != null) {
      children.add(Padding(
        padding: const EdgeInsets.all(AppSpacing.sm),
        child: Text(list.error!, textAlign: TextAlign.center, style: TextStyle(color: context.colorScheme.error)),
      ));
    }
    if (list.hasMore) {
      children.add(Padding(
        padding: const EdgeInsets.symmetric(vertical: AppSpacing.md),
        child: Center(
          child: list.loadingMore
              ? const CircularProgressIndicator()
              : OutlinedButton(onPressed: onLoadMore, child: const Text('Xem thêm')),
        ),
      ));
    }
    return RefreshIndicator(
      onRefresh: onRefresh,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.only(top: AppSpacing.sm, bottom: 120),
        children: children,
      ),
    );
  }
}
