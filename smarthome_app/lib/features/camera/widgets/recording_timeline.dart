import 'package:flutter/material.dart';

import '../../../core/core.dart';
import '../data/camera_api.dart';

/// 24-hour bar of one local day: recorded intervals are filled, a tap picks
/// the time to play from.
class RecordingTimeline extends StatelessWidget {
  const RecordingTimeline({
    super.key,
    required this.day,
    required this.ranges,
    required this.onSelect,
    this.cursor,
  });

  /// Local midnight of the day shown.
  final DateTime day;
  final List<RecordingRange> ranges;
  final DateTime? cursor;
  final ValueChanged<DateTime> onSelect;

  @override
  Widget build(BuildContext context) {
    final scheme = context.colorScheme;
    return LayoutBuilder(
      builder: (context, constraints) {
        final width = constraints.maxWidth;
        return Semantics(
          label: 'Dòng thời gian bản ghi, chạm để chọn thời điểm xem lại',
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTapDown: (details) {
              final fraction = (details.localPosition.dx / width).clamp(0.0, 1.0);
              onSelect(day.add(Duration(seconds: (fraction * 86400).round())));
            },
            child: SizedBox(
              height: 64,
              child: CustomPaint(
                size: Size(width, 64),
                painter: _TimelinePainter(
                  day: day,
                  ranges: ranges,
                  cursor: cursor,
                  track: scheme.surfaceContainerHighest,
                  fill: scheme.primary,
                  cursorColor: scheme.error,
                  labelStyle: context.textTheme.labelSmall?.copyWith(
                        color: scheme.onSurfaceVariant,
                      ) ??
                      TextStyle(color: scheme.onSurfaceVariant, fontSize: 11),
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}

class _TimelinePainter extends CustomPainter {
  _TimelinePainter({
    required this.day,
    required this.ranges,
    required this.cursor,
    required this.track,
    required this.fill,
    required this.cursorColor,
    required this.labelStyle,
  });

  final DateTime day;
  final List<RecordingRange> ranges;
  final DateTime? cursor;
  final Color track;
  final Color fill;
  final Color cursorColor;
  final TextStyle labelStyle;

  @override
  void paint(Canvas canvas, Size size) {
    const barTop = 8.0;
    const barHeight = 24.0;
    final dayEnd = day.add(const Duration(days: 1));
    double x(DateTime time) {
      final seconds = time.difference(day).inMilliseconds / 1000;
      return (seconds / 86400).clamp(0.0, 1.0) * size.width;
    }

    const radius = Radius.circular(6);
    canvas.drawRRect(
      RRect.fromRectAndRadius(Rect.fromLTWH(0, barTop, size.width, barHeight), radius),
      Paint()..color = track,
    );
    final fillPaint = Paint()..color = fill;
    for (final range in ranges) {
      if (!range.end.isAfter(day) || !range.start.isBefore(dayEnd)) continue;
      final left = x(range.start);
      final right = x(range.end);
      canvas.drawRRect(
        RRect.fromRectAndRadius(
          Rect.fromLTWH(left, barTop, (right - left).clamp(2.0, size.width), barHeight),
          const Radius.circular(3),
        ),
        fillPaint,
      );
    }
    final tickPaint = Paint()
      ..color = labelStyle.color ?? Colors.grey
      ..strokeWidth = 1;
    for (var hour = 0; hour <= 24; hour += 3) {
      final dx = size.width * hour / 24;
      canvas.drawLine(Offset(dx, barTop + barHeight), Offset(dx, barTop + barHeight + 4), tickPaint);
      final painter = TextPainter(
        text: TextSpan(text: hour == 24 ? '24h' : '${hour}h', style: labelStyle),
        textDirection: TextDirection.ltr,
      )..layout();
      final left = (dx - painter.width / 2).clamp(0.0, size.width - painter.width);
      painter.paint(canvas, Offset(left, barTop + barHeight + 6));
    }
    final current = cursor;
    if (current != null && !current.isBefore(day) && current.isBefore(dayEnd)) {
      final dx = x(current);
      canvas.drawLine(
        Offset(dx, 2),
        Offset(dx, barTop + barHeight + 4),
        Paint()
          ..color = cursorColor
          ..strokeWidth = 2,
      );
    }
  }

  @override
  bool shouldRepaint(_TimelinePainter oldDelegate) =>
      oldDelegate.day != day ||
      oldDelegate.ranges != ranges ||
      oldDelegate.cursor != cursor ||
      oldDelegate.fill != fill;
}
