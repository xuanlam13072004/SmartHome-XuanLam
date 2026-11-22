/// Vietnamese date/time phrases used across the account center.
abstract final class TimeFormat {
  static String _two(int value) => value.toString().padLeft(2, '0');

  /// 08/11/2026 17:05
  static String dateTime(DateTime time) {
    final t = time.toLocal();
    return '${_two(t.day)}/${_two(t.month)}/${t.year} ${_two(t.hour)}:${_two(t.minute)}';
  }

  /// 08/11/2026
  static String date(DateTime time) {
    final t = time.toLocal();
    return '${_two(t.day)}/${_two(t.month)}/${t.year}';
  }

  /// 17:05
  static String clock(DateTime time) {
    final t = time.toLocal();
    return '${_two(t.hour)}:${_two(t.minute)}';
  }

  /// "Vừa xong", "5 phút trước", "3 giờ trước", "Hôm qua 17:05", then the date.
  static String relative(DateTime time, {DateTime? now}) {
    final current = (now ?? DateTime.now()).toLocal();
    final t = time.toLocal();
    final diff = current.difference(t);
    if (diff.inSeconds < 60) return 'Vừa xong';
    if (diff.inMinutes < 60) return '${diff.inMinutes} phút trước';
    final today = DateTime(current.year, current.month, current.day);
    final day = DateTime(t.year, t.month, t.day);
    if (day == today) return '${diff.inHours} giờ trước';
    if (day == today.subtract(const Duration(days: 1))) return 'Hôm qua ${clock(t)}';
    return dateTime(t);
  }

  /// Heading for a day group: "Hôm nay", "Hôm qua" or 08/11/2026.
  static String dayLabel(DateTime time, {DateTime? now}) {
    final current = (now ?? DateTime.now()).toLocal();
    final t = time.toLocal();
    final today = DateTime(current.year, current.month, current.day);
    final day = DateTime(t.year, t.month, t.day);
    if (day == today) return 'Hôm nay';
    if (day == today.subtract(const Duration(days: 1))) return 'Hôm qua';
    return '${_two(t.day)}/${_two(t.month)}/${t.year}';
  }
}
