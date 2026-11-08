import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';

import '../../../core/core.dart';
import '../data/camera_api.dart';

/// Recorded time is painted yellow, time without a recording stays white.
const Color kRecordedColor = Color(0xFFF5C518);
const Color _recordedEdge = Color(0xFFD9A600);
const Color _emptyColor = Colors.white;

/// Narrowest and widest time window of the ruler.
const Duration kMinTimelineSpan = Duration(minutes: 2);
const Duration kMaxTimelineSpan = Duration(hours: 24);

/// Ruler over a time window of one day: recorded intervals yellow, the rest
/// white. Tap picks the time to play from; drag moves the window; pinch, the
/// mouse wheel or the +/− buttons stretch it down to a few minutes.
class RecordingTimeline extends StatefulWidget {
  const RecordingTimeline({
    super.key,
    required this.start,
    required this.span,
    required this.ranges,
    required this.onSelect,
    required this.onPan,
    required this.onZoom,
    this.cursor,
  });

  /// Left edge of the window.
  final DateTime start;

  /// Width of the window, between [kMinTimelineSpan] and [kMaxTimelineSpan].
  final Duration span;
  final List<RecordingRange> ranges;
  final DateTime? cursor;
  final ValueChanged<DateTime> onSelect;

  /// Time shift of a drag (positive moves later).
  final ValueChanged<Duration> onPan;

  /// Zoom by [factor] (< 1 stretches) keeping [focus] under the same point.
  final void Function(double factor, DateTime focus) onZoom;

  @override
  State<RecordingTimeline> createState() => _RecordingTimelineState();
}

class _RecordingTimelineState extends State<RecordingTimeline> {
  double _lastScale = 1;

  DateTime _timeAt(double dx, double width) {
    final fraction = (dx / (width <= 0 ? 1 : width)).clamp(0.0, 1.0);
    return widget.start.add(Duration(milliseconds: (fraction * widget.span.inMilliseconds).round()));
  }

  @override
  Widget build(BuildContext context) {
    final scheme = context.colorScheme;
    return LayoutBuilder(
      builder: (context, constraints) {
        final width = constraints.maxWidth;
        final msPerPixel = widget.span.inMilliseconds / (width <= 0 ? 1 : width);
        return Semantics(
          label: 'Dòng thời gian bản ghi: màu vàng là có bản ghi. Chạm để xem lại, kéo để di chuyển, chụm hoặc cuộn chuột để phóng to.',
          child: Listener(
            // Mouse wheel / trackpad scroll zooms around the pointer (web, desktop).
            onPointerSignal: (event) {
              if (event is! PointerScrollEvent || event.scrollDelta.dy == 0) return;
              // Claims the wheel so the page does not scroll at the same time.
              GestureBinding.instance.pointerSignalResolver.register(event, (resolved) {
                final scroll = resolved as PointerScrollEvent;
                widget.onZoom(scroll.scrollDelta.dy > 0 ? 1.25 : 0.8, _timeAt(scroll.localPosition.dx, width));
              });
            },
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTapUp: (details) => widget.onSelect(_timeAt(details.localPosition.dx, width)),
              onScaleStart: (_) => _lastScale = 1,
              onScaleUpdate: (details) {
                if (details.pointerCount > 1 && details.scale > 0) {
                  final factor = _lastScale / details.scale;
                  _lastScale = details.scale;
                  widget.onZoom(factor, _timeAt(details.localFocalPoint.dx, width));
                } else if (details.focalPointDelta.dx != 0) {
                  widget.onPan(Duration(milliseconds: (-details.focalPointDelta.dx * msPerPixel).round()));
                }
              },
              child: SizedBox(
                height: 76,
                child: CustomPaint(
                  size: Size(width, 76),
                  painter: _TimelinePainter(
                    start: widget.start,
                    span: widget.span,
                    ranges: widget.ranges,
                    cursor: widget.cursor,
                    border: scheme.outline,
                    cursorColor: scheme.error,
                    labelStyle: context.textTheme.labelSmall?.copyWith(
                          color: scheme.onSurfaceVariant,
                        ) ??
                        TextStyle(color: scheme.onSurfaceVariant, fontSize: 11),
                  ),
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}

/// "Có bản ghi" (yellow) / "Không có bản ghi" (white) legend.
class RecordingLegend extends StatelessWidget {
  const RecordingLegend({super.key});

  @override
  Widget build(BuildContext context) {
    final style = context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant);
    Widget swatch(Color color) => Container(
          width: 14,
          height: 14,
          decoration: BoxDecoration(
            color: color,
            borderRadius: BorderRadius.circular(3),
            border: Border.all(color: context.colorScheme.outline),
          ),
        );
    return Wrap(
      alignment: WrapAlignment.center,
      spacing: AppSpacing.lg,
      runSpacing: AppSpacing.xs,
      children: [
        Row(mainAxisSize: MainAxisSize.min, children: [
          swatch(kRecordedColor),
          const SizedBox(width: AppSpacing.xs),
          Text('Có bản ghi', style: style),
        ]),
        Row(mainAxisSize: MainAxisSize.min, children: [
          swatch(_emptyColor),
          const SizedBox(width: AppSpacing.xs),
          Text('Không có bản ghi', style: style),
        ]),
      ],
    );
  }
}

class _TimelinePainter extends CustomPainter {
  _TimelinePainter({
    required this.start,
    required this.span,
    required this.ranges,
    required this.cursor,
    required this.border,
    required this.cursorColor,
    required this.labelStyle,
  });

  final DateTime start;
  final Duration span;
  final List<RecordingRange> ranges;
  final DateTime? cursor;
  final Color border;
  final Color cursorColor;
  final TextStyle labelStyle;

  static const _steps = [
    Duration(seconds: 30),
    Duration(minutes: 1),
    Duration(minutes: 2),
    Duration(minutes: 5),
    Duration(minutes: 10),
    Duration(minutes: 15),
    Duration(minutes: 30),
    Duration(hours: 1),
    Duration(hours: 2),
    Duration(hours: 3),
  ];

  @override
  void paint(Canvas canvas, Size size) {
    const barTop = 10.0;
    const barHeight = 36.0;
    final end = start.add(span);
    final spanMs = span.inMilliseconds.toDouble();
    double x(DateTime time) {
      final ms = time.difference(start).inMilliseconds.toDouble();
      return (ms / spanMs).clamp(0.0, 1.0) * size.width;
    }

    final bar = RRect.fromRectAndRadius(
      Rect.fromLTWH(0, barTop, size.width, barHeight),
      const Radius.circular(6),
    );
    canvas.drawRRect(bar, Paint()..color = _emptyColor);

    canvas.save();
    canvas.clipRRect(bar);
    final fillPaint = Paint()..color = kRecordedColor;
    final edgePaint = Paint()
      ..color = _recordedEdge
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1;
    for (final range in ranges) {
      if (!range.end.isAfter(start) || !range.start.isBefore(end)) continue;
      final left = x(range.start);
      // Even a few seconds stay visible on the widest window.
      final width = (x(range.end) - left).clamp(3.0, size.width);
      final rect = Rect.fromLTWH(left, barTop, width, barHeight);
      canvas.drawRect(rect, fillPaint);
      canvas.drawRect(rect, edgePaint);
    }

    // Minor ticks inside the bar make a stretched ruler readable.
    final step = _tickStep(span, size.width);
    final minor = Duration(milliseconds: step.inMilliseconds ~/ 5);
    final midnight = DateTime(start.year, start.month, start.day);
    final minorPaint = Paint()
      ..color = border.withValues(alpha: 0.35)
      ..strokeWidth = 1;
    if (minor.inMilliseconds > 0) {
      final firstMinor = (start.difference(midnight).inMilliseconds / minor.inMilliseconds).ceil();
      for (var tick = midnight.add(minor * firstMinor); tick.isBefore(end); tick = tick.add(minor)) {
        final dx = x(tick);
        canvas.drawLine(Offset(dx, barTop + barHeight - 6), Offset(dx, barTop + barHeight), minorPaint);
      }
    }
    canvas.restore();
    canvas.drawRRect(
      bar,
      Paint()
        ..color = border
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1,
    );

    // Labelled ticks are counted from local midnight: 0h, 3h … 24h or 09:30, 09:31 …
    final tickPaint = Paint()
      ..color = labelStyle.color ?? Colors.grey
      ..strokeWidth = 1;
    final firstIndex = (start.difference(midnight).inMilliseconds / step.inMilliseconds).ceil();
    for (var tick = midnight.add(step * firstIndex); !tick.isAfter(end); tick = tick.add(step)) {
      final dx = x(tick);
      canvas.drawLine(Offset(dx, barTop + barHeight), Offset(dx, barTop + barHeight + 5), tickPaint);
      final painter = TextPainter(
        text: TextSpan(text: _tickLabel(tick.difference(midnight), step), style: labelStyle),
        textDirection: TextDirection.ltr,
      )..layout();
      final left = (dx - painter.width / 2).clamp(0.0, size.width - painter.width);
      painter.paint(canvas, Offset(left, barTop + barHeight + 8));
    }

    final current = cursor;
    if (current != null && !current.isBefore(start) && current.isBefore(end)) {
      final dx = x(current);
      canvas.drawLine(
        Offset(dx, 2),
        Offset(dx, barTop + barHeight + 5),
        Paint()
          ..color = cursorColor
          ..strokeWidth = 2,
      );
    }
  }

  /// Smallest step that leaves room for the labels (about one per 64 px).
  static Duration _tickStep(Duration span, double width) {
    final maxTicks = (width / 64).clamp(3.0, 12.0);
    for (final step in _steps) {
      if (span.inMilliseconds / step.inMilliseconds <= maxTicks) return step;
    }
    return _steps.last;
  }

  /// [sinceMidnight] of the window's day; `24h` marks the end of the day.
  static String _tickLabel(Duration sinceMidnight, Duration step) {
    if (step.inHours >= 1) return '${sinceMidnight.inHours}h';
    final hour = (sinceMidnight.inHours % 24).toString().padLeft(2, '0');
    final minute = (sinceMidnight.inMinutes % 60).toString().padLeft(2, '0');
    if (step.inSeconds < 60) {
      final second = (sinceMidnight.inSeconds % 60).toString().padLeft(2, '0');
      return '$hour:$minute:$second';
    }
    return '$hour:$minute';
  }

  @override
  bool shouldRepaint(_TimelinePainter oldDelegate) =>
      oldDelegate.start != start ||
      oldDelegate.span != span ||
      oldDelegate.ranges != ranges ||
      oldDelegate.cursor != cursor;
}
