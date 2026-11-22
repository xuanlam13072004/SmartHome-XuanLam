// Hallmark · charts · one hue per chart (theme primary) · hairline grid · tap or drag for the value
import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../../core/core.dart';
import '../data/device_stats.dart';

const _weekdays = ['Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy', 'Chủ Nhật'];

String _two(int value) => value.toString().padLeft(2, '0');

/// Full name of a bucket: "14:00–15:00, 22/11" or "Thứ Bảy, 22/11".
String bucketLabel(DateTime start, {required bool hourly}) {
  final time = vietnamTime(start);
  final date = '${time.day}/${time.month}';
  if (!hourly) return '${_weekdays[time.weekday - 1]}, $date';
  return '${_two(time.hour)}:00–${_two((time.hour + 1) % 24)}:00, $date';
}

/// Axis label under a bucket, or null: 0h/6h/12h/18h, every day of a week,
/// every 7th day of a month counting back from today.
String? _axisLabel(List<DateTime> buckets, int index, bool hourly) {
  final time = vietnamTime(buckets[index]);
  if (hourly) return time.hour % 6 == 0 ? '${time.hour}h' : null;
  final step = buckets.length <= 7 ? 1 : 7;
  return (buckets.length - 1 - index) % step == 0 ? '${time.day}/${time.month}' : null;
}

/// A round step (1, 2, 2.5 or 5 × 10ⁿ) cutting [span] into about [parts].
double _niceStep(double span, int parts) {
  final raw = span / parts;
  final magnitude = math.pow(10, (math.log(raw) / math.ln10).floor()).toDouble();
  final normalized = raw / magnitude;
  final nice = normalized <= 1
      ? 1.0
      : normalized <= 2
          ? 2.0
          : normalized <= 2.5
              ? 2.5
              : normalized <= 5
                  ? 5.0
                  : 10.0;
  return nice * magnitude;
}

/// The value axis: clean ticks from [min] to [max].
class _Axis {
  _Axis._(this.min, this.max, this.step);

  factory _Axis.around(double low, double high, {bool integers = false}) {
    var lo = low;
    var hi = high;
    if (hi - lo < 1e-9) {
      lo -= 1;
      hi += 1;
    }
    var step = _niceStep(hi - lo, 3);
    if (integers) step = math.max(1.0, step.ceilToDouble());
    return _Axis._((lo / step).floorToDouble() * step, (hi / step).ceilToDouble() * step, step);
  }

  final double min;
  final double max;
  final double step;

  List<double> get ticks => [for (var value = min; value <= max + step / 2; value += step) value];

  String label(double value) {
    if (step % 1 == 0) return value.round().toString();
    return value.toStringAsFixed(1).replaceAll('.', ',');
  }
}

/// Horizontal geometry shared by painting and touch: one slot per bucket
/// right of the tick labels.
class _Frame {
  const _Frame({required this.left, required this.width, required this.count});

  static const double top = 8;
  static const double bottomGutter = 22;

  final double left;
  final double width;
  final int count;

  double get slot => (width - left) / count;

  double x(int index) => left + slot * (index + 0.5);

  int indexAt(double dx) => ((dx - left) / slot).floor().clamp(0, count - 1);
}

double _labelWidth(_Axis axis, TextStyle style) {
  var widest = 0.0;
  for (final tick in axis.ticks) {
    final painter = TextPainter(text: TextSpan(text: axis.label(tick), style: style), textDirection: TextDirection.ltr)
      ..layout();
    widest = math.max(widest, painter.width);
  }
  return widest + 8;
}

void _drawText(Canvas canvas, String text, TextStyle style, Offset anchor, {double alignX = 0, double alignY = 0}) {
  final painter = TextPainter(text: TextSpan(text: text, style: style), textDirection: TextDirection.ltr)..layout();
  painter.paint(canvas, anchor - Offset(painter.width * alignX, painter.height * alignY));
}

/// Grid, tick labels and bucket labels; returns the value → y mapping.
double Function(double) _drawFrame(
  Canvas canvas,
  Size size,
  _Frame frame,
  _Axis axis,
  List<DateTime> buckets,
  bool hourly,
  _ChartColors colors,
) {
  final bottom = size.height - _Frame.bottomGutter;
  double y(double value) => bottom - (value - axis.min) / (axis.max - axis.min) * (bottom - _Frame.top);
  final grid = Paint()
    ..color = colors.grid
    ..strokeWidth = 1;
  for (final tick in axis.ticks) {
    final at = y(tick).roundToDouble() + 0.5;
    canvas.drawLine(Offset(frame.left, at), Offset(size.width, at), grid);
    _drawText(canvas, axis.label(tick), colors.label, Offset(frame.left - 8, at), alignX: 1, alignY: 0.5);
  }
  for (var index = 0; index < buckets.length; index++) {
    final label = _axisLabel(buckets, index, hourly);
    if (label == null) continue;
    _drawText(canvas, label, colors.label, Offset(frame.x(index), bottom + 6), alignX: 0.5);
  }
  return y;
}

class _ChartColors {
  _ChartColors(BuildContext context)
      : mark = context.colorScheme.primary,
        surface = context.neu.surface,
        grid = context.colorScheme.outlineVariant.withValues(alpha: 0.7),
        cursor = context.colorScheme.onSurface.withValues(alpha: 0.35),
        label = context.textTheme.labelSmall!.copyWith(
          color: context.colorScheme.onSurfaceVariant,
          fontFeatures: const [FontFeature.tabularFigures()],
        );

  final Color mark;
  final Color surface;
  final Color grid;
  final Color cursor;
  final TextStyle label;
}

/// Touch layer: a tap or a horizontal drag picks the nearest bucket.
class _TouchChart extends StatelessWidget {
  const _TouchChart({
    required this.height,
    required this.labelWidth,
    required this.count,
    required this.onSelect,
    required this.painter,
    required this.semantics,
  });

  final double height;
  final double labelWidth;
  final int count;
  final ValueChanged<int> onSelect;
  final CustomPainter Function(_Frame frame) painter;
  final String semantics;

  @override
  Widget build(BuildContext context) => Semantics(
        label: semantics,
        child: SizedBox(
          height: height,
          child: LayoutBuilder(
            builder: (context, constraints) {
              final frame = _Frame(left: labelWidth, width: constraints.maxWidth, count: count);
              void pick(Offset position) => onSelect(frame.indexAt(position.dx));
              return GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTapDown: (details) => pick(details.localPosition),
                onHorizontalDragStart: (details) => pick(details.localPosition),
                onHorizontalDragUpdate: (details) => pick(details.localPosition),
                child: CustomPaint(size: Size(constraints.maxWidth, height), painter: painter(frame)),
              );
            },
          ),
        ),
      );
}

/// Muted words then the bold value: "trung bình **31,2°C** · thấp nhất **28°C**".
class StatsReadout extends StatelessWidget {
  const StatsReadout(this.parts, {super.key});

  /// Pairs of (words, value); a null value prints the words alone.
  final List<(String, String?)> parts;

  @override
  Widget build(BuildContext context) {
    final muted = context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant);
    final strong = context.textTheme.bodySmall?.copyWith(
      color: context.colorScheme.onSurface,
      fontWeight: FontWeight.w700,
    );
    final spans = <InlineSpan>[];
    for (final (words, value) in parts) {
      if (spans.isNotEmpty) spans.add(TextSpan(text: '  ·  ', style: muted));
      spans.add(TextSpan(text: value == null ? words : '$words ', style: muted));
      if (value != null) spans.add(TextSpan(text: value, style: strong));
    }
    return Text.rich(TextSpan(children: spans), maxLines: 2);
  }
}

/// Hourly (daily) average as a 2px line over a light band from lowest to highest.
class MeasureChart extends StatefulWidget {
  const MeasureChart({super.key, required this.measure, required this.buckets, required this.hourly, required this.period});

  final StatsMeasure measure;
  final List<DateTime> buckets;
  final bool hourly;

  /// "24 giờ qua", for the summary line.
  final String period;

  @override
  State<MeasureChart> createState() => _MeasureChartState();
}

class _MeasureChartState extends State<MeasureChart> {
  int? _selected;

  @override
  void didUpdateWidget(MeasureChart oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.buckets, widget.buckets)) _selected = null;
  }

  @override
  Widget build(BuildContext context) {
    final measure = widget.measure;
    final colors = _ChartColors(context);
    final axis = _Axis.around(measure.lowest!, measure.highest!);
    final selected = _selected;
    final point = selected == null || selected >= measure.points.length ? null : measure.points[selected];
    final List<(String, String?)> readout = selected == null
        ? [
            (widget.period, null),
            ('trung bình', measure.format(measure.average!)),
            ('thấp nhất', measure.format(measure.lowest!)),
            ('cao nhất', measure.format(measure.highest!)),
          ]
        : point == null
            ? [(bucketLabel(widget.buckets[selected], hourly: widget.hourly), null), ('không có số đo', null)]
            : [
                (bucketLabel(widget.buckets[selected], hourly: widget.hourly), null),
                ('trung bình', measure.format(point.avg)),
                ('từ', '${measure.format(point.min)} – ${measure.format(point.max)}'),
              ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(measure.label, style: context.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
        const SizedBox(height: AppSpacing.xs),
        SizedBox(height: 36, child: StatsReadout(readout)),
        const SizedBox(height: AppSpacing.sm),
        _TouchChart(
          height: 150,
          labelWidth: _labelWidth(axis, colors.label),
          count: widget.buckets.length,
          onSelect: (index) => setState(() => _selected = index),
          semantics: '${measure.label} ${widget.period}: trung bình ${measure.format(measure.average!)}, '
              'thấp nhất ${measure.format(measure.lowest!)}, cao nhất ${measure.format(measure.highest!)}',
          painter: (frame) => _MeasurePainter(
            points: measure.points,
            buckets: widget.buckets,
            hourly: widget.hourly,
            axis: axis,
            frame: frame,
            colors: colors,
            selected: selected,
          ),
        ),
      ],
    );
  }
}

class _MeasurePainter extends CustomPainter {
  _MeasurePainter({
    required this.points,
    required this.buckets,
    required this.hourly,
    required this.axis,
    required this.frame,
    required this.colors,
    required this.selected,
  });

  final List<StatsPoint?> points;
  final List<DateTime> buckets;
  final bool hourly;
  final _Axis axis;
  final _Frame frame;
  final _ChartColors colors;
  final int? selected;

  @override
  void paint(Canvas canvas, Size size) {
    final y = _drawFrame(canvas, size, frame, axis, buckets, hourly, colors);
    final band = Paint()..color = colors.mark.withValues(alpha: 0.12);
    final line = Paint()
      ..color = colors.mark
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;

    // Runs of consecutive readings; a gap (no reading) breaks the line.
    var index = 0;
    while (index < points.length) {
      if (points[index] == null) {
        index++;
        continue;
      }
      final run = <int>[];
      while (index < points.length && points[index] != null) {
        run.add(index++);
      }
      if (run.length == 1) {
        final at = run.single;
        final point = points[at]!;
        canvas.drawRRect(
          RRect.fromRectAndRadius(
            Rect.fromLTRB(frame.x(at) - 3, y(point.max) - 1, frame.x(at) + 3, y(point.min) + 1),
            const Radius.circular(3),
          ),
          band,
        );
        continue;
      }
      final area = Path()..moveTo(frame.x(run.first), y(points[run.first]!.max));
      for (final at in run.skip(1)) {
        area.lineTo(frame.x(at), y(points[at]!.max));
      }
      for (final at in run.reversed) {
        area.lineTo(frame.x(at), y(points[at]!.min));
      }
      canvas.drawPath(area..close(), band);
      final path = Path()..moveTo(frame.x(run.first), y(points[run.first]!.avg));
      for (final at in run.skip(1)) {
        path.lineTo(frame.x(at), y(points[at]!.avg));
      }
      canvas.drawPath(path, line);
    }

    // The latest reading gets an end dot; the picked bucket a cursor.
    final last = points.lastIndexWhere((point) => point != null);
    final pick = selected;
    if (pick != null) {
      final x = frame.x(pick);
      canvas.drawLine(
        Offset(x, _Frame.top),
        Offset(x, size.height - _Frame.bottomGutter),
        Paint()
          ..color = colors.cursor
          ..strokeWidth = 1,
      );
    }
    for (final at in <int>{if (last >= 0) last, if (pick != null) pick}) {
      final point = points[at];
      if (point == null) continue;
      final center = Offset(frame.x(at), y(point.avg));
      canvas.drawCircle(center, 6, Paint()..color = colors.surface);
      canvas.drawCircle(center, 4, Paint()..color = colors.mark);
    }
  }

  @override
  bool shouldRepaint(_MeasurePainter oldDelegate) =>
      oldDelegate.selected != selected || oldDelegate.points != points || oldDelegate.colors.mark != colors.mark ||
      oldDelegate.frame.width != frame.width;
}

/// How many times per hour (day): thin columns rising from one baseline.
class CountChart extends StatefulWidget {
  const CountChart({super.key, required this.perBucket, required this.buckets, required this.hourly, required this.what});

  final List<int> perBucket;
  final List<DateTime> buckets;
  final bool hourly;

  /// "sự kiện", "lệnh": what is counted, for the readout.
  final String what;

  @override
  State<CountChart> createState() => _CountChartState();
}

class _CountChartState extends State<CountChart> {
  int? _selected;

  @override
  void didUpdateWidget(CountChart oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.buckets, widget.buckets)) _selected = null;
  }

  @override
  Widget build(BuildContext context) {
    final colors = _ChartColors(context);
    final highest = widget.perBucket.fold<int>(0, math.max);
    final axis = _Axis.around(0, highest.toDouble(), integers: true);
    final selected = _selected;
    final busiest = widget.perBucket.indexOf(highest);
    final List<(String, String?)> readout = selected == null
        ? [
            (widget.hourly ? 'Nhiều nhất lúc' : 'Nhiều nhất vào', null),
            (bucketLabel(widget.buckets[busiest], hourly: widget.hourly), '$highest ${widget.what}'),
          ]
        : [(bucketLabel(widget.buckets[selected], hourly: widget.hourly), '${widget.perBucket[selected]} ${widget.what}')];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SizedBox(height: 36, child: StatsReadout(readout)),
        const SizedBox(height: AppSpacing.xs),
        _TouchChart(
          height: 130,
          labelWidth: _labelWidth(axis, colors.label),
          count: widget.buckets.length,
          onSelect: (index) => setState(() => _selected = index),
          semantics: 'Số ${widget.what} theo ${widget.hourly ? 'giờ' : 'ngày'}, nhiều nhất $highest',
          painter: (frame) => _CountPainter(
            values: widget.perBucket,
            buckets: widget.buckets,
            hourly: widget.hourly,
            axis: axis,
            frame: frame,
            colors: colors,
            selected: selected,
          ),
        ),
      ],
    );
  }
}

class _CountPainter extends CustomPainter {
  _CountPainter({
    required this.values,
    required this.buckets,
    required this.hourly,
    required this.axis,
    required this.frame,
    required this.colors,
    required this.selected,
  });

  final List<int> values;
  final List<DateTime> buckets;
  final bool hourly;
  final _Axis axis;
  final _Frame frame;
  final _ChartColors colors;
  final int? selected;

  @override
  void paint(Canvas canvas, Size size) {
    final y = _drawFrame(canvas, size, frame, axis, buckets, hourly, colors);
    final width = math.min(24.0, math.max(2.0, frame.slot - 2));
    for (var index = 0; index < values.length && index < buckets.length; index++) {
      if (values[index] <= 0) continue;
      final faded = selected != null && selected != index;
      final paint = Paint()..color = faded ? colors.mark.withValues(alpha: 0.4) : colors.mark;
      final x = frame.x(index);
      final top = math.min(y(values[index].toDouble()), y(0) - 2);
      final radius = Radius.circular(math.min(4.0, width / 2));
      canvas.drawRRect(
        RRect.fromRectAndCorners(Rect.fromLTRB(x - width / 2, top, x + width / 2, y(0)), topLeft: radius, topRight: radius),
        paint,
      );
    }
  }

  @override
  bool shouldRepaint(_CountPainter oldDelegate) =>
      oldDelegate.selected != selected || oldDelegate.values != values || oldDelegate.colors.mark != colors.mark ||
      oldDelegate.frame.width != frame.width;
}
