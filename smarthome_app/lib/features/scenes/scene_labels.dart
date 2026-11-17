import '../../core/utils/app_error_mapper.dart';
import '../../core/utils/time_format.dart';
import '../products/widgets/product_page_kit.dart' show productDurationLabel;

/// Vietnamese labels for scenes, their runs and step inputs.
abstract final class SceneLabels {
  static String runStatus(String status) => switch (status) {
        'running' => 'Đang chạy',
        'succeeded' => 'Thành công',
        'partial' => 'Hoàn thành một phần',
        'failed' => 'Không thành công',
        _ => status,
      };

  static String trigger(String trigger, {String? automationName}) => switch (trigger) {
        'schedule' => 'Hẹn giờ',
        'automation' => automationName == null ? 'Tự động' : 'Tự động: $automationName',
        _ => 'Chạy tay',
      };

  static String stepStatus(String status) => switch (status) {
        'pending' => 'Đang chờ',
        'dispatched' => 'Đang chờ thiết bị',
        'succeeded' => 'Đã xong',
        'failed' => 'Không thành công',
        _ => status,
      };

  /// Why a step failed, in words the user understands.
  static String reason(String? code) =>
      code == null ? 'Không thành công' : AppErrorMapper.messageForCode(code);

  static String delay(int seconds) => seconds <= 0 ? 'Ngay' : 'Chờ ${productDurationLabel(seconds)}';

  static const _values = {
    'manual': 'Thủ công',
    'automatic': 'Tự động',
  };

  static const _fields = {
    'duration_seconds': 'Thời lượng',
    'mode': 'Chế độ',
    'lines': 'Nội dung hiển thị',
  };

  /// A catalog enum value in words ("automatic" → "Tự động").
  static String value(Object? value) => _values['$value'] ?? '$value';

  /// An input field's name in words.
  static String field(String name) => _fields[name] ?? name;

  /// "5 phút", "Tự động", "Dòng 1: Xin chào…" — the step's input in one line.
  static String input(Map<String, dynamic> input) {
    final parts = <String>[];
    for (final entry in input.entries) {
      final value = entry.value;
      if (value is num && entry.key.endsWith('_seconds')) {
        parts.add(productDurationLabel(value.toInt()));
      } else if (value is List) {
        final lines = value.map((line) => '$line'.trim()).where((line) => line.isNotEmpty).toList();
        if (lines.isNotEmpty) parts.add('“${lines.join(' / ')}”');
      } else if (value is bool) {
        parts.add(value ? 'Bật' : 'Tắt');
      } else if (value != null) {
        parts.add(SceneLabels.value(value));
      }
    }
    return parts.join(' · ');
  }

  // ── Schedules ────────────────────────────────────────────────────────────

  static const weekdayShort = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];

  /// "Hằng ngày", "Thứ 2–6", "Cuối tuần" or "T2, T4, CN" (1 = Monday … 7 = Sunday).
  static String days(List<int> days) {
    final set = days.toSet();
    if (set.length == 7) return 'Hằng ngày';
    if (set.length == 5 && set.containsAll(const [1, 2, 3, 4, 5])) return 'Thứ 2–6';
    if (set.length == 2 && set.containsAll(const [6, 7])) return 'Cuối tuần';
    final sorted = set.toList()..sort();
    return sorted.map((day) => weekdayShort[day - 1]).join(', ');
  }

  /// "Hôm nay 19:00", "Ngày mai 06:30", "T2 06:30".
  static String nextRun(DateTime time, {DateTime? now}) {
    final current = (now ?? DateTime.now()).toLocal();
    final t = time.toLocal();
    final today = DateTime(current.year, current.month, current.day);
    final day = DateTime(t.year, t.month, t.day);
    final clock = TimeFormat.clock(t);
    if (day == today) return 'Hôm nay $clock';
    if (day == today.add(const Duration(days: 1))) return 'Ngày mai $clock';
    return '${weekdayShort[t.weekday - 1]} $clock';
  }

  /// What happened the last time a schedule came due.
  static String? lastResult(String? result, DateTime? at) {
    if (result == null || at == null) return null;
    final when = TimeFormat.relative(at);
    return switch (result) {
      'started' => 'Đã chạy $when',
      'skipped_running' => 'Bỏ qua $when vì kịch bản đang chạy',
      'skipped_protected' => 'Bỏ qua $when: có thao tác cần mật khẩu',
      'skipped_empty' => 'Bỏ qua $when: kịch bản không còn bước nào',
      'missed' => 'Bị lỡ $when (máy chủ không hoạt động)',
      _ => null,
    };
  }
}
