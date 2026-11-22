import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons/lucide_icons.dart';

import '../../../core/core.dart';
import '../../../core/utils/app_error_mapper.dart';
import '../../../core/utils/time_format.dart';
import '../../../core/widgets/widgets.dart';
import '../data/assistant_models.dart';
import '../providers/assistant_providers.dart';

String _number(int value) {
  final digits = value.toString();
  final buffer = StringBuffer();
  for (var i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 == 0) buffer.write('.');
    buffer.write(digits[i]);
  }
  return buffer.toString();
}

/// "Gói dịch vụ": the assistant's monthly allowance and the plans. Only the
/// assistant is limited; controlling devices and alerts are always free.
class PlansScreen extends ConsumerWidget {
  const PlansScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final usage = ref.watch(assistantUsageProvider);
    return PageScaffold(
      scrollable: false,
      appBar: AppBar(title: const Text('Gói dịch vụ')),
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
      child: RefreshIndicator(
        onRefresh: () async {
          ref.invalidate(assistantUsageProvider);
          try {
            await ref.read(assistantUsageProvider.future);
          } catch (_) {}
        },
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.only(top: AppSpacing.sm, bottom: 120),
          children: usage.when(
            loading: () => const [SizedBox(height: 200, child: Center(child: CircularProgressIndicator()))],
            error: (error, _) => [
              EmptyState(
                icon: LucideIcons.alertTriangle,
                title: 'Không tải được gói dịch vụ',
                description: AppErrorMapper.mapError(error),
                actionText: 'Thử lại',
                onActionTap: () => ref.invalidate(assistantUsageProvider),
              ),
            ],
            data: (data) => [
              _UsageCard(usage: data),
              const SizedBox(height: AppSpacing.lg),
              for (final plan in data.plans) _PlanCard(plan: plan, current: plan.code == data.plan.code),
              const SizedBox(height: AppSpacing.sm),
              Text(
                'Giới hạn chỉ áp dụng cho trợ lý. Điều khiển thiết bị trên ứng dụng và cảnh báo an toàn luôn miễn phí.',
                style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _UsageCard extends StatelessWidget {
  const _UsageCard({required this.usage});

  final AssistantUsage usage;

  @override
  Widget build(BuildContext context) {
    final muted = context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant);
    return NeuCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Icon(LucideIcons.sparkles, color: context.colorScheme.primary),
              const SizedBox(width: AppSpacing.sm),
              Text('Gói ${usage.plan.name}', style: context.textTheme.titleMedium),
            ],
          ),
          const SizedBox(height: AppSpacing.md),
          ClipRRect(
            borderRadius: BorderRadius.circular(4),
            child: LinearProgressIndicator(value: usage.usedFraction, minHeight: 8),
          ),
          const SizedBox(height: AppSpacing.sm),
          Text('Đã dùng ${_number(usage.usedTokens)} / ${_number(usage.plan.monthlyTokens)} token tháng này', style: muted),
          if (usage.resetsAt != null)
            Text('Làm mới vào ${TimeFormat.dateTime(usage.resetsAt!)}', style: muted),
          if (usage.expiresAt != null)
            Text('Gói hiện tại hết hạn ${TimeFormat.dateTime(usage.expiresAt!)}', style: muted),
        ],
      ),
    );
  }
}

class _PlanCard extends StatelessWidget {
  const _PlanCard({required this.plan, required this.current});

  final AssistantPlan plan;
  final bool current;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.smMd),
      child: NeuCard(
        child: Row(
          children: [
            Icon(plan.priceVnd == 0 ? LucideIcons.zap : LucideIcons.crown, color: context.colorScheme.primary),
            const SizedBox(width: AppSpacing.md),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(plan.name, style: context.textTheme.titleSmall),
                  Text(
                    '${_number(plan.monthlyTokens)} token/tháng · khoảng ${_number(plan.approximateTurns)} lượt hỏi',
                    style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant),
                  ),
                ],
              ),
            ),
            const SizedBox(width: AppSpacing.sm),
            if (current)
              Chip(label: const Text('Đang dùng'), visualDensity: VisualDensity.compact)
            else
              Text(
                plan.priceVnd == 0 ? 'Miễn phí' : '${_number(plan.priceVnd)}đ/tháng',
                style: context.textTheme.labelLarge,
              ),
          ],
        ),
      ),
    );
  }
}
