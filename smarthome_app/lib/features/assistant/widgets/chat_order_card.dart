import 'package:flutter/material.dart';
import 'package:lucide_icons/lucide_icons.dart';

import '../../../core/core.dart';
import '../../../core/utils/time_format.dart';
import '../../../core/widgets/widgets.dart';
import '../../payments/data/payment_models.dart';
import '../../payments/widgets/payment_widgets.dart';

/// An order made in the chat: its QR while it waits for the transfer, then
/// what happened (paid, part paid, expired, cancelled).
class ChatOrderCard extends StatelessWidget {
  const ChatOrderCard({
    super.key,
    required this.order,
    required this.replaced,
    required this.busy,
    required this.onSimulate,
    required this.onCancel,
    required this.onRenew,
  });

  final PaymentOrder order;

  /// A newer order took its place (the server cancelled this one).
  final bool replaced;
  final bool busy;
  final VoidCallback onSimulate;
  final VoidCallback onCancel;
  final VoidCallback onRenew;

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 420),
        child: Padding(
          padding: const EdgeInsets.only(bottom: AppSpacing.sm),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              NeuCard(
                child: Row(
                  children: [
                    Icon(LucideIcons.crown, color: context.colorScheme.primary),
                    const SizedBox(width: AppSpacing.sm),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('Gói ${order.planName} · ${order.months} tháng', style: context.textTheme.titleSmall),
                          Text('Mã đơn ${order.code}', style: context.textTheme.bodySmall),
                        ],
                      ),
                    ),
                    Text(formatVnd(order.amount), style: context.textTheme.titleSmall),
                  ],
                ),
              ),
              const SizedBox(height: AppSpacing.sm),
              ..._body(context),
            ],
          ),
        ),
      ),
    );
  }

  List<Widget> _body(BuildContext context) {
    if (order.paid) {
      return [
        _Line(
          icon: LucideIcons.checkCircle2,
          color: context.neu.successColor,
          text: order.planExpiresAt == null
              ? 'Đã thanh toán'
              : 'Đã thanh toán · gói ${order.planName} dùng đến ${TimeFormat.date(order.planExpiresAt!)}',
        ),
      ];
    }
    if (replaced) {
      return [const _Line(icon: LucideIcons.refreshCw, text: 'Đã thay bằng mã thanh toán mới bên dưới.')];
    }
    switch (order.status) {
      case 'cancelled':
        return [const _Line(icon: LucideIcons.xCircle, text: 'Đơn đã hủy.')];
      case 'expired':
        return [
          const _Line(icon: LucideIcons.clock3, text: 'Mã QR đã hết hạn.'),
          const SizedBox(height: AppSpacing.xs),
          OutlinedButton.icon(
            onPressed: busy ? null : onRenew,
            icon: const Icon(LucideIcons.qrCode, size: 18),
            label: const Text('Tạo mã mới'),
          ),
        ];
    }
    return [
      if (order.status == 'review')
        Padding(
          padding: const EdgeInsets.only(bottom: AppSpacing.sm),
          child: _Line(
            icon: LucideIcons.info,
            color: context.neu.warningColor,
            text: 'Đã nhận ${formatVnd(order.received)}, còn thiếu ${formatVnd(order.amount - order.received)}.',
          ),
        ),
      if (order.mock) ...[
        MockPaymentPanel(busy: busy, onPay: onSimulate),
        const SizedBox(height: AppSpacing.sm),
      ],
      if (order.transfer != null) TransferDetails(transfer: order.transfer!, qrSize: 180),
      if (order.expiresAt != null && order.status == 'pending') ...[
        const SizedBox(height: AppSpacing.xs),
        QrCountdown(until: order.expiresAt!),
      ],
      const SizedBox(height: AppSpacing.xs),
      Row(
        children: [
          const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2)),
          const SizedBox(width: AppSpacing.sm),
          Expanded(
            child: Text(
              'Đang chờ tiền về, mình sẽ báo ngay trong cuộc trò chuyện này.',
              style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant),
            ),
          ),
          if (order.status == 'pending')
            TextButton(onPressed: busy ? null : onCancel, child: const Text('Hủy đơn')),
        ],
      ),
    ];
  }
}

class _Line extends StatelessWidget {
  const _Line({required this.icon, required this.text, this.color});

  final IconData icon;
  final String text;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Icon(icon, size: 18, color: color ?? context.colorScheme.onSurfaceVariant),
        const SizedBox(width: AppSpacing.sm),
        Expanded(child: Text(text, style: context.textTheme.bodyMedium)),
      ],
    );
  }
}
