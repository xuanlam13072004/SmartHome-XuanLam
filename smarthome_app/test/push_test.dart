import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:smarthome_app/core/navigation/app_routes.dart';
import 'package:smarthome_app/domain/models/ws_events.dart';

void main() {
  test('plan reminders arrive as account events with the plan to renew', () {
    final event = WsEventParser.parse(jsonEncode({
      'event': 'plan_expiring',
      'data': {
        'plan': {'code': 'basic', 'name': 'Cơ bản'},
        'expires_at': '2026-12-22T05:00:00Z',
        'stage': '3d',
      },
    }));
    expect(event, isA<AccountNotificationEvent>());
    final notice = event as AccountNotificationEvent;
    expect(notice.event, 'plan_expiring');
    expect((notice.data['plan'] as Map)['code'], 'basic');
    expect(WsEventParser.parse(jsonEncode({'event': 'plan_expired', 'data': {}})), isA<AccountNotificationEvent>());
  });

  test('a plan reminder opens the chat with that plan offered', () {
    expect(AppRoutes.assistantRenewOf('basic'), '/assistant?renew=basic');
    expect(Uri.parse(AppRoutes.assistantRenewOf('pro')).queryParameters['renew'], 'pro');
  });
}
