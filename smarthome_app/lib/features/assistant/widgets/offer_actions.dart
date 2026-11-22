import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons/lucide_icons.dart';

import '../../../core/core.dart';
import '../../../core/navigation/app_routes.dart';
import '../../payments/data/payment_models.dart';
import '../../payments/providers/payments_providers.dart';
import '../data/assistant_models.dart';
import '../providers/assistant_chat.dart';
import '../providers/assistant_providers.dart';

/// The buttons under a plan offer. Nothing is ordered until one is tapped:
/// one confirm button when the months are known, otherwise one per duration.
class OfferActions extends StatelessWidget {
  const OfferActions({
    super.key,
    required this.offer,
    required this.state,
    required this.onBuy,
    required this.onDismiss,
  });

  final PlanOffer offer;
  final OfferState state;
  final void Function(int months) onBuy;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    final muted = context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant);
    if (state == OfferState.ordering) {
      return Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2)),
          const SizedBox(width: AppSpacing.sm),
          Text('Đang tạo mã thanh toán…', style: muted),
        ],
      );
    }
    if (state == OfferState.ordered) {
      return Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(LucideIcons.checkCircle2, size: 16, color: context.neu.successColor),
          const SizedBox(width: AppSpacing.xs),
          Text('Đã tạo mã thanh toán', style: muted),
        ],
      );
    }
    if (state == OfferState.dismissed) return Text('Đã bỏ qua', style: muted);
    final chosen = offer.chosen;
    return Wrap(
      spacing: AppSpacing.xs,
      runSpacing: AppSpacing.xs,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        if (chosen != null)
          FilledButton(
            onPressed: () => onBuy(chosen.months),
            child: Text('Xác nhận · ${formatVnd(chosen.amount)}'),
          )
        else
          for (final price in offer.prices)
            FilledButton.tonal(
              onPressed: () => onBuy(price.months),
              child: Text('${price.months} tháng · ${formatVnd(price.amount)}'),
            ),
        TextButton(onPressed: onDismiss, child: const Text('Thôi')),
      ],
    );
  }
}

/// Shown when the month's allowance is used up: the bigger plans to buy
/// right in the chat (renewing the same plan would not add tokens this month).
class QuotaPlans extends ConsumerWidget {
  const QuotaPlans({super.key, required this.onPick});

  final void Function(PaymentPlan plan) onPick;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final options = ref.watch(paymentOptionsProvider).valueOrNull;
    final usage = ref.watch(assistantUsageProvider).valueOrNull;
    final current = usage?.plan.monthlyTokens ?? 0;
    final bigger = options != null && options.available
        ? options.plans.where((plan) => plan.monthlyTokens > current && plan.prices.isNotEmpty).toList()
        : const <PaymentPlan>[];
    return Wrap(
      spacing: AppSpacing.xs,
      runSpacing: AppSpacing.xs,
      children: [
        for (final plan in bigger)
          FilledButton.tonal(
            onPressed: () => onPick(plan),
            child: Text('Nâng cấp gói ${plan.name}'),
          ),
        TextButton(
          onPressed: () => context.push(AppRoutes.profilePlans),
          child: const Text('Xem các gói'),
        ),
      ],
    );
  }
}
