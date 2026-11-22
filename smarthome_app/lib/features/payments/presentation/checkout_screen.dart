import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../../../core/core.dart';
import '../../../core/utils/app_error_mapper.dart';
import '../../../core/utils/time_format.dart';
import '../../../core/widgets/widgets.dart';
import '../../assistant/providers/assistant_providers.dart';
import '../data/payment_models.dart';
import '../providers/payments_providers.dart';

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
  Timer? _clock;
  bool _acting = false;

  @override
  void initState() {
    super.initState();
    _load();
    _poll = Timer.periodic(const Duration(seconds: 4), (_) {
      if (_order?.open ?? true) _load();
    });
    _clock = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted && (_order?.open ?? false)) setState(() {});
    });
  }

  @override
  void dispose() {
    _poll?.cancel();
    _clock?.cancel();
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

  void _copy(String label, String value) {
    Clipboard.setData(ClipboardData(text: value));
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Đã chép $label')));
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
                  if (order.mock) _MockPanel(busy: _acting, onPay: () => _act(() async {
                        await ref.read(paymentsApiProvider).simulate(order.code);
                      })),
                  if (order.transfer != null) _Transfer(transfer: order.transfer!, onCopy: _copy),
                  if (order.expiresAt != null && order.status == 'pending') ...[
                    const SizedBox(height: AppSpacing.sm),
                    _Countdown(until: order.expiresAt!),
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

class _Transfer extends StatelessWidget {
  const _Transfer({required this.transfer, required this.onCopy});

  final PaymentTransfer transfer;
  final void Function(String label, String value) onCopy;

  @override
  Widget build(BuildContext context) {
    final rows = <(String, String, bool)>[
      if (transfer.bankName != null) ('Ngân hàng', transfer.bankName!, false),
      ('Số tài khoản', transfer.accountNumber, true),
      if (transfer.accountName != null) ('Chủ tài khoản', transfer.accountName!, false),
      ('Số tiền', formatVnd(transfer.amount), false),
      ('Nội dung', transfer.note, true),
    ];
    return NeuCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('Quét mã bằng ứng dụng ngân hàng', style: context.textTheme.titleSmall, textAlign: TextAlign.center),
          const SizedBox(height: AppSpacing.sm),
          Center(
            child: Container(
              padding: const EdgeInsets.all(AppSpacing.sm),
              decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(AppRadius.sm)),
              child: QrImageView(data: transfer.qr, size: 220, backgroundColor: Colors.white),
            ),
          ),
          const SizedBox(height: AppSpacing.md),
          for (final (label, value, copyable) in rows)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 2),
              child: Row(
                children: [
                  SizedBox(width: 110, child: Text(label, style: context.textTheme.bodySmall)),
                  Expanded(
                    child: Text(value, style: context.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
                  ),
                  if (copyable)
                    IconButton(
                      visualDensity: VisualDensity.compact,
                      tooltip: 'Chép',
                      icon: const Icon(LucideIcons.copy, size: 16),
                      onPressed: () => onCopy(label.toLowerCase(), value),
                    ),
                ],
              ),
            ),
          const SizedBox(height: AppSpacing.xs),
          Text(
            'Chuyển khoản thủ công thì nhập đúng nội dung "${transfer.note}" để hệ thống nhận ra.',
            style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant),
          ),
        ],
      ),
    );
  }
}

class _MockPanel extends StatelessWidget {
  const _MockPanel({required this.busy, required this.onPay});

  final bool busy;
  final VoidCallback onPay;

  @override
  Widget build(BuildContext context) {
    return NeuCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Icon(LucideIcons.flaskConical, color: context.neu.warningColor),
              const SizedBox(width: AppSpacing.sm),
              Expanded(child: Text('Chế độ thử nghiệm: không chuyển tiền thật.', style: context.textTheme.bodyMedium)),
            ],
          ),
          const SizedBox(height: AppSpacing.sm),
          FilledButton(onPressed: busy ? null : onPay, child: const Text('Giả lập đã thanh toán')),
        ],
      ),
    );
  }
}

class _Countdown extends StatelessWidget {
  const _Countdown({required this.until});

  final DateTime until;

  @override
  Widget build(BuildContext context) {
    final left = until.difference(DateTime.now());
    final text = left.isNegative
        ? 'Mã QR đã hết hạn'
        : 'Mã QR còn hiệu lực ${left.inMinutes.toString().padLeft(2, '0')}:${(left.inSeconds % 60).toString().padLeft(2, '0')}';
    return Text(text, textAlign: TextAlign.center, style: context.textTheme.bodyMedium);
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
