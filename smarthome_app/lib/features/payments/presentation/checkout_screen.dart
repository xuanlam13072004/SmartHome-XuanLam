import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons/lucide_icons.dart';

import '../../../core/core.dart';
import '../../../core/utils/app_error_mapper.dart';
import '../../../core/utils/time_format.dart';
import '../../../core/widgets/widgets.dart';
import '../../assistant/providers/assistant_providers.dart';
import '../data/payment_models.dart';
import '../providers/payments_providers.dart';
import '../widgets/payment_widgets.dart';

/// The order's VietQR and transfer details, a countdown, and its status kept
/// up to date (polling) until the transfer arrives.
class CheckoutScreen extends ConsumerStatefulWidget {
  const CheckoutScreen({super.key, required this.code});

  final String code;

  @override
  ConsumerState<CheckoutScreen> createState() => _CheckoutScreenState();
}

class _CheckoutScreenState extends ConsumerState<CheckoutScreen> {
  PaymentOrder? _order;
  Object? _error;
  Timer? _poll;
  bool _acting = false;

  @override
  void initState() {
    super.initState();
    _load();
    _poll = Timer.periodic(const Duration(seconds: 4), (_) {
      if (_order?.open ?? true) _load();
    });
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final order = await ref.read(paymentsApiProvider).order(widget.code);
      if (!mounted) return;
      final justPaid = order.paid && !(_order?.paid ?? false);
      setState(() {
        _order = order;
        _error = null;
      });
      if (justPaid) {
        ref.invalidate(assistantUsageProvider);
        ref.invalidate(paymentOrdersProvider);
      }
    } catch (error) {
      if (mounted && _order == null) setState(() => _error = error);
    }
  }

  Future<void> _act(Future<void> Function() action) async {
    setState(() => _acting = true);
    try {
      await action();
      await _load();
    } catch (error) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(AppErrorMapper.mapError(error))));
    } finally {
      if (mounted) setState(() => _acting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final order = _order;
    return PageScaffold(
      scrollable: false,
      appBar: AppBar(title: const Text('Thanh toán')),
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
      child: order == null
          ? (_error != null
              ? EmptyState(
                  icon: LucideIcons.alertTriangle,
                  title: 'Không tải được đơn hàng',
                  description: AppErrorMapper.mapError(_error),
                  actionText: 'Thử lại',
                  onActionTap: _load,
                )
              : const Center(child: CircularProgressIndicator()))
          : ListView(
              padding: const EdgeInsets.only(top: AppSpacing.sm, bottom: 120),
              children: [
                _Summary(order: order),
                const SizedBox(height: AppSpacing.md),
                if (order.paid)
                  _Paid(order: order)
                else if (order.status == 'cancelled')
                  const _Notice(icon: LucideIcons.xCircle, text: 'Đơn hàng đã hủy.')
                else if (order.status == 'expired')
                  const _Notice(
                    icon: LucideIcons.clock3,
                    text: 'Mã QR đã hết hạn. Nếu bạn đã chuyển khoản đúng nội dung, gói vẫn được kích hoạt khi tiền đến. '
                        'Nếu chưa, hãy tạo đơn mới.',
                  )
                else ...[
                  if (order.status == 'review')
                    _Notice(
                      icon: LucideIcons.info,
                      text: 'Đã nhận ${formatVnd(order.received)}, còn thiếu ${formatVnd(order.amount - order.received)}. '
                          'Chuyển nốt phần còn lại với cùng nội dung.',
                    ),
                  if (order.mock)
                    MockPaymentPanel(
                      busy: _acting,
                      onPay: () => _act(() async {
                        await ref.read(paymentsApiProvider).simulate(order.code);
                      }),
                    ),
                  if (order.transfer != null) TransferDetails(transfer: order.transfer!),
                  if (order.expiresAt != null && order.status == 'pending') ...[
                    const SizedBox(height: AppSpacing.sm),
                    QrCountdown(until: order.expiresAt!),
                  ],
                  const SizedBox(height: AppSpacing.md),
                  Row(
                    children: [
                      const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)),
                      const SizedBox(width: AppSpacing.sm),
                      Expanded(
                        child: Text(
                          'Đang chờ tiền về. Gói được kích hoạt tự động, bạn không cần ở lại màn hình này.',
                          style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant),
                        ),
                      ),
                    ],
                  ),
                  if (order.status == 'pending') ...[
                    const SizedBox(height: AppSpacing.md),
                    OutlinedButton(
                      onPressed: _acting
                          ? null
                          : () => _act(() async {
                                await ref.read(paymentsApiProvider).cancel(order.code);
                                ref.invalidate(paymentOrdersProvider);
                              }),
                      child: const Text('Hủy đơn'),
                    ),
                  ],
                ],
              ],
            ),
    );
  }
}

class _Summary extends StatelessWidget {
  const _Summary({required this.order});

  final PaymentOrder order;

  @override
  Widget build(BuildContext context) {
    return NeuCard(
      child: Row(
        children: [
          Icon(LucideIcons.crown, color: context.colorScheme.primary),
          const SizedBox(width: AppSpacing.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Gói ${order.planName} · ${order.months} tháng', style: context.textTheme.titleMedium),
                Text('Mã đơn ${order.code}', style: context.textTheme.bodySmall),
              ],
            ),
          ),
          Text(formatVnd(order.amount), style: context.textTheme.titleMedium),
        ],
      ),
    );
  }
}

class _Paid extends StatelessWidget {
  const _Paid({required this.order});

  final PaymentOrder order;

  @override
  Widget build(BuildContext context) {
    return NeuCard(
      child: Column(
        children: [
          Icon(LucideIcons.checkCircle2, size: 48, color: context.neu.successColor),
          const SizedBox(height: AppSpacing.sm),
          Text('Thanh toán thành công', style: context.textTheme.titleLarge),
          if (order.planExpiresAt != null) ...[
            const SizedBox(height: AppSpacing.xs),
            Text('Gói ${order.planName} dùng đến ${TimeFormat.dateTime(order.planExpiresAt!)}', textAlign: TextAlign.center),
          ],
          const SizedBox(height: AppSpacing.md),
          FilledButton(onPressed: () => context.pop(), child: const Text('Xong')),
        ],
      ),
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice({required this.icon, required this.text});

  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.md),
      child: NeuCard(
        child: Row(
          children: [
            Icon(icon, color: context.colorScheme.onSurfaceVariant),
            const SizedBox(width: AppSpacing.sm),
            Expanded(child: Text(text, style: context.textTheme.bodyMedium)),
          ],
        ),
      ),
    );
  }
}
