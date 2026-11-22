import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../../../core/core.dart';
import '../../../core/widgets/widgets.dart';
import '../data/payment_models.dart';

/// Copies [value] and says so.
void copyPaymentValue(BuildContext context, String label, String value) {
  Clipboard.setData(ClipboardData(text: value));
  ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Đã chép $label')));
}

/// The VietQR and the transfer details (account, amount, note), with copy buttons.
/// Shared by the checkout screen and the assistant chat.
class TransferDetails extends StatelessWidget {
  const TransferDetails({super.key, required this.transfer, this.qrSize = 220});

  final PaymentTransfer transfer;
  final double qrSize;

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
              child: QrImageView(data: transfer.qr, size: qrSize, backgroundColor: Colors.white),
            ),
          ),
          const SizedBox(height: AppSpacing.md),
          for (final (label, value, copyable) in rows)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 2),
              child: Row(
                children: [
                  SizedBox(width: 100, child: Text(label, style: context.textTheme.bodySmall)),
                  Expanded(
                    child: Text(value, style: context.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
                  ),
                  if (copyable)
                    IconButton(
                      visualDensity: VisualDensity.compact,
                      tooltip: 'Chép',
                      icon: const Icon(LucideIcons.copy, size: 16),
                      onPressed: () => copyPaymentValue(context, label.toLowerCase(), value),
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

/// Test mode (PAYMENT_MODE=mock): no real money, a button pays the order.
class MockPaymentPanel extends StatelessWidget {
  const MockPaymentPanel({super.key, required this.busy, required this.onPay});

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

/// "Mã QR còn hiệu lực 14:59", ticking every second.
class QrCountdown extends StatefulWidget {
  const QrCountdown({super.key, required this.until});

  final DateTime until;

  @override
  State<QrCountdown> createState() => _QrCountdownState();
}

class _QrCountdownState extends State<QrCountdown> {
  late final Timer _timer;

  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _timer.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final left = widget.until.difference(DateTime.now());
    final text = left.isNegative
        ? 'Mã QR đã hết hạn'
        : 'Mã QR còn hiệu lực ${left.inMinutes.toString().padLeft(2, '0')}:${(left.inSeconds % 60).toString().padLeft(2, '0')}';
    return Text(text, textAlign: TextAlign.center, style: context.textTheme.bodyMedium);
  }
}
