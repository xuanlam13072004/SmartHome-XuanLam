import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons/lucide_icons.dart';

import '../../../core/core.dart';
import '../../../core/navigation/app_routes.dart';
import '../../../core/utils/app_error_mapper.dart';
import '../../../core/utils/time_format.dart';
import '../../../core/widgets/widgets.dart';
import '../../payments/data/payment_models.dart';
import '../../payments/presentation/buy_plan_sheet.dart';
import '../../payments/providers/payments_providers.dart';
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

/// "Gói dịch vụ": the assistant's monthly allowance, the plans to buy and the
/// payment history. Only the assistant is limited; controlling devices and
/// alerts are always free.
class PlansScreen extends ConsumerWidget {
  const PlansScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final usage = ref.watch(assistantUsageProvider);
    final options = ref.watch(paymentOptionsProvider).valueOrNull;
    final orders = ref.watch(paymentOrdersProvider).valueOrNull ?? const <PaymentOrder>[];
    return PageScaffold(
      scrollable: false,
      appBar: AppBar(title: const Text('Gói dịch vụ')),
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
      child: RefreshIndicator(
        onRefresh: () async {
          ref
            ..invalidate(assistantUsageProvider)
            ..invalidate(paymentOptionsProvider)
            ..invalidate(paymentOrdersProvider);
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
              if (options?.mock ?? false)
                Padding(
                  padding: const EdgeInsets.only(bottom: AppSpacing.sm),
                  child: Text(
                    'Thanh toán đang ở chế độ thử nghiệm: không chuyển tiền thật.',
                    style: context.textTheme.bodySmall?.copyWith(color: context.neu.warningColor),
                  ),
                ),
              for (final plan in data.plans)
                _PlanCard(
                  plan: plan,
                  current: plan.code == data.plan.code,
                  onBuy: _purchasable(options, plan.code) == null
                      ? null
                      : () => showBuyPlanSheet(context, _purchasable(options, plan.code)!, currentPlan: data.plan.code),
                ),
              const SizedBox(height: AppSpacing.sm),
              Text(
                'Giới hạn chỉ áp dụng cho trợ lý. Điều khiển thiết bị trên ứng dụng và cảnh báo an toàn luôn miễn phí.',
                style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant),
              ),
              if (orders.isNotEmpty) ...[
                const SizedBox(height: AppSpacing.lg),
                Text('Lịch sử thanh toán', style: context.textTheme.titleSmall),
                const SizedBox(height: AppSpacing.sm),
                for (final order in orders) _OrderTile(order: order),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

PaymentPlan? _purchasable(PaymentOptions? options, String code) {
  if (options == null || !options.available) return null;
  for (final plan in options.plans) {
    if (plan.code == code) return plan;
  }
  return null;
}

class _OrderTile extends StatelessWidget {
  const _OrderTile({required this.order});

  final PaymentOrder order;

  static const _labels = {
    'pending': 'Chờ thanh toán',
    'review': 'Thiếu tiền',
    'expired': 'Hết hạn',
    'paid': 'Đã thanh toán',
    'cancelled': 'Đã hủy',
  };

  @override
  Widget build(BuildContext context) {
    final color = order.paid
        ? context.neu.successColor
        : order.open
            ? context.neu.warningColor
            : context.colorScheme.onSurfaceVariant;
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.sm),
      child: NeuCard(
        padding: EdgeInsets.zero,
        child: ListTile(
          leading: Icon(LucideIcons.receipt, color: color),
          title: Text('Gói ${order.planName} · ${order.months} tháng · ${formatVnd(order.amount)}'),
          subtitle: Text([
            _labels[order.status] ?? order.status,
            if (order.createdAt != null) TimeFormat.dateTime(order.createdAt!),
          ].join(' · ')),
          trailing: order.open || order.status == 'expired' ? const Icon(LucideIcons.chevronRight) : null,
          onTap: order.open || order.status == 'expired' ? () => context.push(AppRoutes.paymentCheckoutOf(order.code)) : null,
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
            Text(
              'Gói hiện tại hết hạn ${TimeFormat.dateTime(usage.expiresAt!)}',
              style: usage.expiresAt!.difference(DateTime.now()) < const Duration(days: 3)
                  ? muted?.copyWith(color: context.neu.warningColor, fontWeight: FontWeight.w600)
                  : muted,
            ),
        ],
      ),
    );
  }
}

class _PlanCard extends StatelessWidget {
  const _PlanCard({required this.plan, required this.current, this.onBuy});

  final AssistantPlan plan;
  final bool current;

  /// Buy (or renew) this plan; null when it cannot be bought here.
  final VoidCallback? onBuy;

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
            Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                if (current)
                  Chip(label: const Text('Đang dùng'), visualDensity: VisualDensity.compact)
                else
                  Text(
                    plan.priceVnd == 0 ? 'Miễn phí' : '${_number(plan.priceVnd)}đ/tháng',
                    style: context.textTheme.labelLarge,
                  ),
                if (onBuy != null)
                  TextButton(onPressed: onBuy, child: Text(current ? 'Gia hạn' : 'Mua')),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
