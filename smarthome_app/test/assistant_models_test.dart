import 'package:flutter_test/flutter_test.dart';
import 'package:smarthome_app/features/assistant/data/assistant_models.dart';

void main() {
  test('a turn with a command waiting for confirmation and a question back', () {
    final reply = AssistantReply.fromJson({
      'message': 'mở khóa cửa chính',
      'reply': '"Mở khóa" (Cửa chính) cần bạn xác nhận.',
      'outcome': 'confirm',
      'actions': [
        {
          'kind': 'device',
          'label': 'Mở khóa',
          'target': 'Cửa chính',
          'status': 'pending',
          'pending_id': 'abcDEF123456',
          'confirmation': 'confirm',
        },
      ],
      'clarification': null,
      'usage': {'used_tokens': 2400, 'monthly_tokens': 100000, 'plan': 'free'},
      'transcript': 'mở khóa cửa chính',
      'voice_verified': true,
    });
    expect(reply.actions.single.pending, isTrue);
    expect(reply.actions.single.needsPassword, isFalse);
    expect(reply.usedTokens, 2400);
    expect(reply.voiceVerified, isTrue);
    final done = reply.actions.single.copyWith(status: 'sent');
    expect(done.pending, isFalse);

    final asked = AssistantReply.fromJson({
      'reply': 'Bạn muốn khóa cửa nào?',
      'outcome': 'clarify',
      'actions': [],
      'clarification': {'question': 'Bạn muốn khóa cửa nào?', 'options': ['Cửa chính', 'Cửa sau']},
      'usage': {},
    });
    expect(asked.options, ['Cửa chính', 'Cửa sau']);
    expect(asked.transcript, isNull);
  });

  test('usage and plans', () {
    final usage = AssistantUsage.fromJson({
      'plan': {'code': 'basic', 'name': 'Cơ bản', 'monthly_tokens': 1500000, 'price_vnd': 49000, 'expires_at': '2026-12-21T00:00:00Z'},
      'used_tokens': 375000,
      'remaining_tokens': 1125000,
      'resets_at': '2026-11-30T17:00:00Z',
      'plans': [
        {'code': 'free', 'name': 'Miễn phí', 'monthly_tokens': 100000, 'price_vnd': 0},
        {'code': 'basic', 'name': 'Cơ bản', 'monthly_tokens': 1500000, 'price_vnd': 49000},
      ],
    });
    expect(usage.usedFraction, closeTo(0.25, 1e-9));
    expect(usage.plans.first.approximateTurns, 40);
    expect(usage.expiresAt, isNotNull);
  });
}
