import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/core.dart';
import '../../../core/navigation/app_routes.dart';
import '../../../core/utils/app_error_mapper.dart';
import '../data/payment_models.dart';
import '../providers/payments_providers.dart';

/// Chooses 1 or 12 months of [plan], creates the order, opens the checkout.
Future<void> showBuyPlanSheet(BuildContext context, PaymentPlan plan, {String? currentPlan}) {
  return showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (_) => _BuyPlanSheet(plan: plan, currentPlan: currentPlan),
  );
}

class _BuyPlanSheet extends ConsumerStatefulWidget {
  const _BuyPlanSheet({required this.plan, this.currentPlan});

  final PaymentPlan plan;
  final String? currentPlan;

  @override
  ConsumerState<_BuyPlanSheet> createState() => _BuyPlanSheetState();
}

class _BuyPlanSheetState extends ConsumerState<_BuyPlanSheet> {
  late int _months = widget.plan.prices.first.months;
  bool _busy = false;
  String? _error;

  Future<void> _buy() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final order = await ref.read(paymentsApiProvider).createOrder(planCode: widget.plan.code, months: _months);
      if (!mounted) return;
      final router = GoRouter.of(context);
      Navigator.of(context).pop();
      router.push(AppRoutes.paymentCheckoutOf(order.code));
    } catch (error) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = AppErrorMapper.mapError(error);
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final plan = widget.plan;
    final switching = widget.currentPlan != null && widget.currentPlan != 'free' && widget.currentPlan != plan.code;
    return Padding(
      padding: EdgeInsets.fromLTRB(
        AppSpacing.lg, 0, AppSpacing.lg, AppSpacing.lg + MediaQuery.viewInsetsOf(context).bottom,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('Mua gói ${plan.name}', style: context.textTheme.titleLarge),
          const SizedBox(height: AppSpacing.md),
          for (final price in plan.prices)
            RadioListTile<int>(
              value: price.months,
              groupValue: _months,
              onChanged: _busy ? null : (value) => setState(() => _months = value ?? _months),
              contentPadding: EdgeInsets.zero,
              title: Text(price.months == 12 ? '12 tháng' : '1 tháng'),
              subtitle: price.months == 12 && plan.prices.first.amount > 0
                  ? Text('Tiết kiệm ${formatVnd(plan.prices.first.amount * 12 - price.amount)}')
                  : null,
              secondary: Text(formatVnd(price.amount), style: context.textTheme.titleMedium),
            ),
          if (switching) ...[
            const SizedBox(height: AppSpacing.xs),
            Text(
              'Thời gian còn lại của gói hiện tại được quy đổi theo giá sang gói mới.',
              style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant),
            ),
          ],
          if (_error != null) ...[
            const SizedBox(height: AppSpacing.sm),
            Text(_error!, style: TextStyle(color: context.colorScheme.error)),
          ],
          const SizedBox(height: AppSpacing.md),
          FilledButton(
            onPressed: _busy ? null : _buy,
            child: _busy
                ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                : const Text('Tiếp tục thanh toán'),
          ),
        ],
      ),
    );
  }
}
