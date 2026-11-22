import 'package:flutter_test/flutter_test.dart';
import 'package:smarthome_app/features/assistant/data/assistant_models.dart';
import 'package:smarthome_app/features/assistant/data/chat_texts.dart';
import 'package:smarthome_app/features/payments/data/payment_models.dart';

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

  test('a plan offer: known months get one confirm button, unknown months a choice', () {
    final reply = AssistantReply.fromJson({
      'reply': 'Bạn xác nhận mua gói Cơ bản 1 tháng, giá 49.000đ nhé?',
      'outcome': 'confirm',
      'actions': [],
      'offer': {
        'plan': {'code': 'basic', 'name': 'Cơ bản'},
        'months': 1,
        'prices': [
          {'months': 1, 'amount_vnd': 49000},
          {'months': 12, 'amount_vnd': 490000},
        ],
      },
      'usage': {},
    });
    expect(reply.offer?.planCode, 'basic');
    expect(reply.offer?.chosen?.amount, 49000);
    final open = PlanOffer.fromJson({
      'plan': {'code': 'pro', 'name': 'Nâng cao'},
      'months': null,
      'prices': [
        {'months': 1, 'amount_vnd': 99000},
        {'months': 12, 'amount_vnd': 990000},
      ],
    });
    expect(open.months, isNull);
    expect(open.chosen, isNull);
    expect(ChatTexts.offerFromList(open), 'Gói Nâng cao: 1 tháng 99.000đ, 12 tháng 990.000đ. Bạn muốn mua 1 tháng hay 12 tháng?');
    expect(PlanOffer.fromJson({'plan': {'code': 'basic'}, 'months': 6, 'prices': []}).months, isNull,
        reason: 'months without a price are not offered');
    expect(AssistantReply.fromJson({'reply': 'Chào bạn', 'usage': {}}).offer, isNull);
  });

  test('what the chat says as an order changes', () {
    PaymentOrder order(String status, {int received = 0, String? planExpiresAt}) => PaymentOrder.fromJson({
          'code': 'SHABCD2345',
          'plan': {'code': 'basic', 'name': 'Cơ bản'},
          'months': 1,
          'amount_vnd': 49000,
          'received_vnd': received,
          'status': status,
          'plan_expires_at': planExpiresAt,
        });
    final pending = order('pending');
    expect(ChatTexts.orderChanged(pending, order('pending')), isNull);
    expect(ChatTexts.orderChanged(pending, order('review', received: 20000)),
        startsWith('Mình mới nhận 20.000đ, còn thiếu 29.000đ.'));
    final paid = ChatTexts.orderChanged(pending, order('paid', received: 49000, planExpiresAt: '2026-12-22T05:00:00Z'))!;
    expect(paid, startsWith('Thanh toán thành công! Mình đã nhận 49.000đ, gói Cơ bản đã được kích hoạt đến '));
    expect(paid, matches(RegExp(r'đến \d{2}/\d{2}/2026\.$')));
    expect(ChatTexts.orderChanged(pending, order('expired')), contains('đã hết hạn'));
    expect(ChatTexts.orderChanged(pending, order('cancelled')), 'Đã hủy đơn SHABCD2345.');
  });
}
