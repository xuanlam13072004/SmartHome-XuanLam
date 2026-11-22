/// Assistant ("Trợ lý") data from /assistant/….
library;

Map<String, dynamic> _map(Object? value) =>
    value is Map ? Map<String, dynamic>.from(value) : <String, dynamic>{};

int _int(Object? value) => value is num ? value.toInt() : 0;

/// A command of one turn and what happened to it.
class AssistantAction {
  const AssistantAction({
    required this.kind,
    required this.label,
    required this.target,
    required this.status,
    this.reason,
    this.pendingId,
    this.confirmation,
  });

  /// device · scene
  final String kind;
  final String label;
  final String target;

  /// sent · pending · failed · refused
  final String status;
  final String? reason;

  /// Set while the command waits for the user's confirmation.
  final String? pendingId;

  /// confirm (a tap) · reauthenticate (the password)
  final String? confirmation;

  bool get pending => status == 'pending' && pendingId != null;
  bool get needsPassword => confirmation == 'reauthenticate';

  AssistantAction copyWith({required String status, String? reason}) => AssistantAction(
        kind: kind,
        label: label,
        target: target,
        status: status,
        reason: reason,
        confirmation: confirmation,
      );

  factory AssistantAction.fromJson(Map<String, dynamic> json) => AssistantAction(
        kind: json['kind']?.toString() ?? 'device',
        label: json['label']?.toString() ?? '',
        target: json['target']?.toString() ?? '',
        status: json['status']?.toString() ?? 'failed',
        reason: json['reason']?.toString(),
        pendingId: json['pending_id']?.toString(),
        confirmation: json['confirmation']?.toString(),
      );
}

class AssistantReply {
  const AssistantReply({
    required this.message,
    required this.reply,
    required this.outcome,
    required this.actions,
    required this.options,
    required this.usedTokens,
    required this.monthlyTokens,
    this.transcript,
    this.voiceVerified,
  });

  final String message;
  final String reply;

  /// chat · action · clarify · confirm · refused · error
  final String outcome;
  final List<AssistantAction> actions;

  /// Choices offered with a question back.
  final List<String> options;
  final int usedTokens;
  final int monthlyTokens;

  /// What the assistant heard (spoken messages).
  final String? transcript;
  final bool? voiceVerified;

  factory AssistantReply.fromJson(Map<String, dynamic> json) {
    final usage = _map(json['usage']);
    final clarification = _map(json['clarification']);
    return AssistantReply(
      message: json['message']?.toString() ?? '',
      reply: json['reply']?.toString() ?? '',
      outcome: json['outcome']?.toString() ?? 'chat',
      actions: [
        for (final item in json['actions'] as List? ?? const []) AssistantAction.fromJson(_map(item)),
      ],
      options: [for (final item in clarification['options'] as List? ?? const []) item.toString()],
      usedTokens: _int(usage['used_tokens']),
      monthlyTokens: _int(usage['monthly_tokens']),
      transcript: json['transcript']?.toString(),
      voiceVerified: json['voice_verified'] is bool ? json['voice_verified'] as bool : null,
    );
  }
}

class AssistantPlan {
  const AssistantPlan({required this.code, required this.name, required this.monthlyTokens, required this.priceVnd});

  final String code;
  final String name;
  final int monthlyTokens;
  final int priceVnd;

  /// A turn costs roughly 2,500 tokens (home data + question + answer).
  int get approximateTurns => monthlyTokens ~/ 2500;

  factory AssistantPlan.fromJson(Map<String, dynamic> json) => AssistantPlan(
        code: json['code']?.toString() ?? 'free',
        name: json['name']?.toString() ?? '',
        monthlyTokens: _int(json['monthly_tokens']),
        priceVnd: _int(json['price_vnd']),
      );
}

/// GET /assistant/usage: the current plan, this month's usage and every plan.
class AssistantUsage {
  const AssistantUsage({
    required this.plan,
    required this.expiresAt,
    required this.usedTokens,
    required this.remainingTokens,
    required this.resetsAt,
    required this.plans,
  });

  final AssistantPlan plan;
  final DateTime? expiresAt;
  final int usedTokens;
  final int remainingTokens;
  final DateTime? resetsAt;
  final List<AssistantPlan> plans;

  double get usedFraction => plan.monthlyTokens == 0 ? 1 : (usedTokens / plan.monthlyTokens).clamp(0.0, 1.0);

  factory AssistantUsage.fromJson(Map<String, dynamic> json) {
    final plan = _map(json['plan']);
    return AssistantUsage(
      plan: AssistantPlan.fromJson(plan),
      expiresAt: plan['expires_at'] is String ? DateTime.tryParse(plan['expires_at'] as String)?.toLocal() : null,
      usedTokens: _int(json['used_tokens']),
      remainingTokens: _int(json['remaining_tokens']),
      resetsAt: json['resets_at'] is String ? DateTime.tryParse(json['resets_at'] as String)?.toLocal() : null,
      plans: [for (final item in json['plans'] as List? ?? const []) AssistantPlan.fromJson(_map(item))],
    );
  }
}
