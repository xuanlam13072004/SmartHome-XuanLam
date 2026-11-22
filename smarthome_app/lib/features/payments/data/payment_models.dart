/// Payments for assistant plans (/payments/…).
library;

Map<String, dynamic> _map(Object? value) =>
    value is Map ? Map<String, dynamic>.from(value) : <String, dynamic>{};

int _int(Object? value) => value is num ? value.toInt() : 0;

DateTime? _time(Object? value) => value is String ? DateTime.tryParse(value)?.toLocal() : null;

/// Thousands with dots: 490000 → "490.000".
String formatVnd(int value) {
  final digits = value.toString();
  final buffer = StringBuffer();
  for (var i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 == 0) buffer.write('.');
    buffer.write(digits[i]);
  }
  return '$bufferđ';
}

class PlanPrice {
  const PlanPrice({required this.months, required this.amount});

  final int months;
  final int amount;
}

class PaymentPlan {
  const PaymentPlan({required this.code, required this.name, required this.monthlyTokens, required this.prices});

  final String code;
  final String name;
  final int monthlyTokens;
  final List<PlanPrice> prices;

  factory PaymentPlan.fromJson(Map<String, dynamic> json) => PaymentPlan(
        code: json['code']?.toString() ?? '',
        name: json['name']?.toString() ?? '',
        monthlyTokens: _int(json['monthly_tokens']),
        prices: [
          for (final item in json['prices'] as List? ?? const [])
            PlanPrice(months: _int(_map(item)['months']), amount: _int(_map(item)['amount_vnd'])),
        ],
      );
}

class PaymentOptions {
  const PaymentOptions({required this.mode, required this.available, required this.plans, this.bankName});

  /// off · mock (no real money) · bank (VietQR)
  final String mode;
  final bool available;
  final String? bankName;
  final List<PaymentPlan> plans;

  bool get mock => mode == 'mock';

  factory PaymentOptions.fromJson(Map<String, dynamic> json) => PaymentOptions(
        mode: json['mode']?.toString() ?? 'off',
        available: json['available'] == true,
        bankName: json['bank_name']?.toString(),
        plans: [for (final item in json['plans'] as List? ?? const []) PaymentPlan.fromJson(_map(item))],
      );
}

/// Where and how much to transfer; the note must carry the order code.
class PaymentTransfer {
  const PaymentTransfer({
    required this.bankBin,
    required this.accountNumber,
    required this.amount,
    required this.note,
    required this.qr,
    this.bankName,
    this.accountName,
  });

  final String? bankName;
  final String bankBin;
  final String accountNumber;
  final String? accountName;
  final int amount;
  final String note;

  /// VietQR payload for the banking app.
  final String qr;

  factory PaymentTransfer.fromJson(Map<String, dynamic> json) => PaymentTransfer(
        bankName: json['bank_name']?.toString(),
        bankBin: json['bank_bin']?.toString() ?? '',
        accountNumber: json['account_number']?.toString() ?? '',
        accountName: json['account_name']?.toString(),
        amount: _int(json['amount_vnd']),
        note: json['note']?.toString() ?? '',
        qr: json['qr']?.toString() ?? '',
      );
}

class PaymentOrder {
  const PaymentOrder({
    required this.code,
    required this.planCode,
    required this.planName,
    required this.months,
    required this.amount,
    required this.received,
    required this.status,
    required this.mock,
    this.expiresAt,
    this.createdAt,
    this.paidAt,
    this.planExpiresAt,
    this.transfer,
  });

  final String code;
  final String planCode;
  final String planName;
  final int months;
  final int amount;
  final int received;

  /// pending · expired · review (part paid) · paid · cancelled
  final String status;
  final bool mock;
  final DateTime? expiresAt;
  final DateTime? createdAt;
  final DateTime? paidAt;
  final DateTime? planExpiresAt;
  final PaymentTransfer? transfer;

  bool get open => status == 'pending' || status == 'review';
  bool get paid => status == 'paid';

  factory PaymentOrder.fromJson(Map<String, dynamic> json) {
    final plan = _map(json['plan']);
    return PaymentOrder(
      code: json['code']?.toString() ?? '',
      planCode: plan['code']?.toString() ?? '',
      planName: plan['name']?.toString() ?? '',
      months: _int(json['months']),
      amount: _int(json['amount_vnd']),
      received: _int(json['received_vnd']),
      status: json['status']?.toString() ?? 'pending',
      mock: json['mock'] == true,
      expiresAt: _time(json['expires_at']),
      createdAt: _time(json['created_at']),
      paidAt: _time(json['paid_at']),
      planExpiresAt: _time(json['plan_expires_at']),
      transfer: json['transfer'] is Map ? PaymentTransfer.fromJson(_map(json['transfer'])) : null,
    );
  }
}
