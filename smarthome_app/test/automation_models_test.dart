import 'package:flutter_test/flutter_test.dart';
import 'package:smarthome_app/features/automations/automation_labels.dart';
import 'package:smarthome_app/features/automations/data/automation_models.dart';

// The shape GET /automations returns (api-gateway/src/modules/automations/service.ts).
const _doorAtNight = {
  'id': 'a1',
  'name': 'Cửa mở lúc đêm',
  'enabled': true,
  'trigger': {
    'kind': 'state',
    'device': {'mac': 'AA:BB:CC:DD:EE:01', 'name': 'Cửa chính', 'product_id': 'prod_entrance_controller'},
    'property': 'instances.door_position.reported.door_state',
    'label': 'Trạng thái cửa',
    'instance_label': 'Cảm biến cửa',
    'operator': 'eq',
    'value': 'open',
    'unit': null,
    'available': true,
  },
  'conditions': [
    {
      'device': {'mac': 'AA:BB:CC:DD:EE:02', 'name': 'Bếp', 'product_id': 'prod_hazard_mitigation'},
      'property': 'instances.kitchen_temperature.reported.temperature',
      'label': 'Nhiệt độ',
      'instance_label': 'Nhiệt độ',
      'operator': 'gt',
      'value': 35,
      'unit': 'celsius',
      'available': false,
    },
  ],
  'window': {'from': '23:00', 'to': '05:00'},
  'timezone': 'Asia/Ho_Chi_Minh',
  'scene': null,
  'notify_message': 'Cửa chính vừa mở lúc đêm.',
  'cooldown_seconds': 300,
  'suggestion': 'night_door:AA:BB:CC:DD:EE:01',
  'next_run_at': null,
  'last_triggered_at': null,
  'last_result': null,
  'last_run_id': null,
};

void main() {
  test('an automation reads back into the same request body', () {
    final automation = Automation.fromJson(Map<String, dynamic>.from(_doorAtNight));
    expect(automation.trigger.kind, 'state');
    expect(automation.hasUnavailableParts, isTrue);
    final draft = AutomationDraft(
      name: automation.name,
      enabled: automation.enabled,
      trigger: automation.trigger,
      conditions: automation.conditions,
      timezone: automation.timezone,
      cooldownSeconds: automation.cooldownSeconds,
      windowFrom: automation.windowFrom,
      windowTo: automation.windowTo,
      sceneId: automation.sceneId,
      notifyMessage: automation.notifyMessage,
    ).toJson();
    expect(draft['trigger'], {
      'kind': 'state',
      'mac': 'AA:BB:CC:DD:EE:01',
      'property': 'instances.door_position.reported.door_state',
      'operator': 'eq',
      'value': 'open',
    });
    expect(draft['window'], {'from': '23:00', 'to': '05:00'});
    expect((draft['conditions'] as List).single['value'], 35);
  });

  test('time triggers and the status pushed after a firing', () {
    final automation = Automation.fromJson({
      ..._doorAtNight,
      'trigger': {'kind': 'time', 'time': '23:00', 'days': [1, 2, 3, 4, 5, 6, 7]},
    });
    expect(AutomationLabels.trigger(automation.trigger), '23:00 · Hằng ngày');
    expect(automation.trigger.toJson(), {'kind': 'time', 'time': '23:00', 'days': [1, 2, 3, 4, 5, 6, 7]});
    final fired = automation.withStatus({
      'automation_id': 'a1',
      'last_triggered_at': '2026-11-13T16:00:00.000Z',
      'last_result': 'skipped_conditions',
      'last_run_id': null,
      'next_run_at': '2026-11-14T16:00:00.000Z',
    });
    expect(fired.lastResult, 'skipped_conditions');
    expect(fired.nextRunAt, DateTime.parse('2026-11-14T16:00:00.000Z').toLocal());
  });

  test('comparisons read as Vietnamese sentences', () {
    final automation = Automation.fromJson(Map<String, dynamic>.from(_doorAtNight));
    expect(AutomationLabels.comparison(automation.trigger.state!), 'Trạng thái cửa là Mở');
    expect(AutomationLabels.comparison(automation.conditions.single), 'Nhiệt độ trên 35°C');
    expect(AutomationLabels.value('online', false), 'Mất kết nối');
    expect(AutomationLabels.value('incident_state', 'idle'), 'Không có sự cố');
    expect(AutomationLabels.value('lock_state', 'locked'), 'Đã khóa');
    expect(AutomationLabels.cooldown(3600), '1 giờ');
  });
}
