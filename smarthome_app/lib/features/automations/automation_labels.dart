import 'package:flutter/material.dart';

import '../../core/utils/time_format.dart';
import '../notifications/notification_labels.dart';
import '../scenes/scene_labels.dart';
import 'data/automation_models.dart';

/// Vietnamese words for automations: states, events, results.
abstract final class AutomationLabels {
  // ── Values of device states ───────────────────────────────────────────────

  static const _values = {
    'locked': 'Đã khóa',
    'unlocking': 'Đang mở khóa',
    'unlocked': 'Đã mở khóa',
    'locking': 'Đang khóa',
    'closed': 'Đóng',
    'opening': 'Đang mở',
    'open': 'Mở',
    'closing': 'Đang đóng',
    'unknown': 'Không rõ',
    'fault': 'Lỗi',
    'ready': 'Sẵn sàng',
    'calibrating': 'Đang hiệu chuẩn',
    'warming_up': 'Đang khởi động',
    'ok': 'Bình thường',
    'normal': 'Bình thường',
    'warning': 'Cảnh báo',
    'alarm': 'Báo động',
    'emergency': 'Khẩn cấp',
    'sensor_fault': 'Lỗi cảm biến',
    'active': 'Đang có sự cố',
    'acknowledged': 'Đã xác nhận',
    'silent': 'Im lặng',
    'sounding': 'Đang kêu',
    'muted': 'Đã tạm tắt',
    'offline': 'Ngoại tuyến',
    'idle': 'Đang chờ',
    'streaming': 'Đang phát',
    'unavailable': 'Không khả dụng',
    'recording': 'Đang ghi',
    'stopped': 'Đã dừng',
    'waiting_time_sync': 'Chờ đồng bộ giờ',
    'recycling': 'Đang xoay vòng',
    'missing': 'Không có thẻ nhớ',
    'available': 'Đủ nước',
    'low': 'Sắp hết',
    'empty': 'Đã cạn',
    'running': 'Đang chạy',
    'manual': 'Thủ công',
    'automatic': 'Tự động',
    'healthy': 'Ổn định',
    'completed': 'Hoàn tất',
    'user_request': 'Người dùng dừng',
    'low_water': 'Thiếu nước',
    'reservoir_sensor_fault': 'Lỗi cảm biến bể',
    'maximum_runtime': 'Quá thời gian tối đa',
    'controller_restart': 'Bộ điều khiển khởi động lại',
  };

  /// Values whose meaning depends on the state (`idle` of an incident).
  static const _byState = {
    'incident_state': {'idle': 'Không có sự cố'},
    'pump_output_state': {'stopped': 'Đang dừng'},
  };

  static const _booleans = {
    'online': ('Đang kết nối', 'Mất kết nối'),
    'rain_detected': ('Có mưa', 'Không mưa'),
    'flame_detected': ('Có lửa', 'Không có lửa'),
    'pin_configured': ('Đã đặt mã', 'Chưa đặt mã'),
  };

  static const _units = {
    'celsius': '°C',
    'percent': '%',
    'degree': '°',
    'dbm': ' dBm',
    'second': ' giây',
  };

  /// Unit shown after a number ("°C"), empty when there is none.
  static String unit(String? unit) => (_units[unit] ?? '').trim();

  /// A value of the state [name] (`door_state`) in words.
  static String value(String name, Object? value, {String? unit}) {
    if (value is bool) {
      final pair = _booleans[name];
      return pair == null ? (value ? 'Có' : 'Không') : (value ? pair.$1 : pair.$2);
    }
    if (value is num) {
      final text = value == value.roundToDouble() ? value.toInt().toString() : value.toString();
      return '$text${_units[unit] ?? ''}';
    }
    return _byState[name]?['$value'] ?? _values['$value'] ?? '$value';
  }

  static String operatorLabel(String operator, String kind) => switch (operator) {
        'ne' => 'không phải',
        'gt' => 'trên',
        'lt' => 'dưới',
        _ => kind == 'boolean' ? ':' : 'là',
      };

  /// "Trạng thái cửa là Mở", "Nhiệt độ trên 35°C", "Kết nối: Mất kết nối".
  static String comparison(StateComparison state) {
    final kind = state.value is bool ? 'boolean' : state.value is num ? 'number' : 'enum';
    final text = value(state.name, state.value, unit: state.unit);
    return kind == 'boolean' ? '${state.label}: $text' : '${state.label} ${operatorLabel(state.operator, kind)} $text';
  }

  // ── Events ────────────────────────────────────────────────────────────────

  static const _events = {
    'lock_changed': 'Khóa đổi trạng thái',
    'door_opened': 'Cửa được mở',
    'door_closed': 'Cửa được đóng',
    'pin_access_granted': 'Nhập đúng mã PIN',
    'keypad_action': 'Có thao tác trên bàn phím',
    'motion_started': 'Mái bắt đầu chuyển động',
    'motion_completed': 'Mái dừng chuyển động',
    'rain_stopped': 'Trời tạnh mưa',
    'button_pressed': 'Nút trên thiết bị được nhấn',
    'incident_started': 'Bắt đầu sự cố an toàn',
    'incident_acknowledged': 'Sự cố được xác nhận',
    'incident_resolved': 'Sự cố kết thúc',
    'siren_tested': 'Thử còi báo động',
    'watering_started': 'Bắt đầu tưới',
    'watering_stopped': 'Dừng tưới',
    'storage_recycled': 'Bộ nhớ ghi hình xoay vòng',
    'recordings_deleted': 'Bản ghi bị xóa',
    'recordings_wiped': 'Toàn bộ bản ghi bị xóa',
  };

  static String event(String eventName) => _events[eventName] ?? NotificationLabels.eventTitle(eventName, const {});

  // ── Summaries ────────────────────────────────────────────────────────────

  /// What starts it: "Cửa chính: Trạng thái cửa là Mở", "23:00 · Hằng ngày".
  static String trigger(AutomationTrigger trigger) => switch (trigger.kind) {
        'state' => '${trigger.state!.deviceName}: ${comparison(trigger.state!)}',
        'event' => '${trigger.event!.deviceName}: ${event(trigger.event!.eventName)}',
        _ => '${trigger.time} · ${SceneLabels.days(trigger.days)}',
      };

  static IconData triggerIcon(String kind) => switch (kind) {
        'state' => Icons.sensors_rounded,
        'event' => Icons.notifications_active_rounded,
        _ => Icons.schedule_rounded,
      };

  static String window(String from, String to) => 'Chỉ từ $from đến $to';

  static const cooldowns = [60, 300, 900, 3600];

  static String cooldown(int seconds) => seconds >= 3600 ? '${seconds ~/ 3600} giờ' : '${seconds ~/ 60} phút';

  /// What happened the last time it was triggered.
  static String? lastResult(String? result, DateTime? at) {
    if (result == null || at == null) return null;
    final when = TimeFormat.relative(at);
    return switch (result) {
      'started' => 'Đã chạy kịch bản $when',
      'notified' => 'Đã gửi thông báo $when',
      'skipped_running' => 'Bỏ qua kịch bản $when vì nó đang chạy',
      'skipped_protected' => 'Bỏ qua $when: kịch bản có thao tác cần mật khẩu',
      'skipped_empty' => 'Bỏ qua $when: kịch bản không còn bước nào',
      'skipped_conditions' => 'Không chạy $when: điều kiện chưa đúng',
      'no_action' => 'Không có gì để làm $when (kịch bản đã bị xóa)',
      'unavailable' => 'Không chạy $when: thiết bị không còn được chia sẻ',
      'missed' => 'Bị lỡ $when (máy chủ không hoạt động)',
      _ => null,
    };
  }

  /// Icon of a suggestion by template.
  static IconData suggestionIcon(String template) => switch (template) {
        'gas_vent' => Icons.air_rounded,
        'night_lock' => Icons.lock_clock_rounded,
        'night_door' => Icons.nightlight_rounded,
        'rain_stop' => Icons.umbrella_rounded,
        'offline' => Icons.wifi_off_rounded,
        _ => Icons.lightbulb_outline_rounded,
      };
}
