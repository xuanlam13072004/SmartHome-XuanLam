// Hallmark · camera page · video first → state strip → live/replay switch → timeline → manage
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/core.dart';
import '../../../core/utils/app_error_mapper.dart';
import '../../../core/widgets/widgets.dart';
import '../../../domain/models/device_model.dart';
import '../camera_labels.dart';
import '../data/camera_api.dart';
import '../player/hls_video_controller.dart';
import '../player/hls_video_view.dart';
import '../widgets/recording_timeline.dart';
import 'camera_session_holder.dart';

enum CameraViewMode { live, playback }

/// The whole camera page: the video is the first thing on screen and live
/// view starts by itself, like consumer camera apps. Sessions are closed when
/// the page goes away.
class CameraViewerPanel extends ConsumerStatefulWidget {
  const CameraViewerPanel({super.key, required this.device});

  final DeviceModel device;

  @override
  ConsumerState<CameraViewerPanel> createState() => _CameraViewerPanelState();
}

class _CameraViewerPanelState extends ConsumerState<CameraViewerPanel> {
  late final CameraApi _api;
  late final CameraSessionHolder _holder;
  final HlsVideoController _player = HlsVideoController();
  CameraViewMode _mode = CameraViewMode.live;

  String? _url;
  bool _opening = false;
  String? _sessionError;
  bool _liveAutoStarted = false;

  DateTime _day = _today();
  /// Visible part of the day on the timeline (24 h, 6 h or 1 h).
  Duration _span = const Duration(hours: 24);
  DateTime _windowStart = _today();
  Timer? _rangesTimer;
  List<RecordingRange> _ranges = const [];
  bool _loadingRanges = false;
  bool _rangesInFlight = false;
  String? _rangesError;
  DateTime? _playbackFrom;
  DateTime? _playbackTo;
  DateTime? _cursor;
  Timer? _cursorTimer;
  bool _deleting = false;

  static DateTime _today() {
    final now = DateTime.now();
    return DateTime(now.year, now.month, now.day);
  }

  DeviceModel get _device => widget.device;
  bool get _online => _device.status == DeviceStatus.online;

  @override
  void initState() {
    super.initState();
    _api = ref.read(cameraApiProvider);
    _holder = CameraSessionHolder(_api);
    _player.addListener(_onPlayerChanged);
    _cursorTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (_mode != CameraViewMode.playback || _url == null) return;
      final now = _player.currentWallTime;
      if (now != null && now != _cursor && mounted) setState(() => _cursor = now);
    });
    // Today's recordings grow while the camera records: keep the timeline fresh.
    _rangesTimer = Timer.periodic(const Duration(seconds: 20), (_) {
      if (_mode != CameraViewMode.playback || _rangesInFlight || _day != _today()) return;
      unawaited(_loadRanges(silent: true));
    });
    WidgetsBinding.instance.addPostFrameCallback((_) => _maybeAutoStartLive());
  }

  @override
  void didUpdateWidget(CameraViewerPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    // The webcam came back (or the camera reconnected): start live by itself.
    if (!oldWidget.device.cameraHasImage && _device.cameraHasImage) _liveAutoStarted = false;
    WidgetsBinding.instance.addPostFrameCallback((_) => _maybeAutoStartLive());
  }

  @override
  void dispose() {
    _cursorTimer?.cancel();
    _rangesTimer?.cancel();
    _player.removeListener(_onPlayerChanged);
    _player.dispose();
    unawaited(_holder.close());
    super.dispose();
  }

  void _onPlayerChanged() {
    if (mounted) setState(() {});
  }

  void _maybeAutoStartLive() {
    if (!mounted || _mode != CameraViewMode.live || _liveAutoStarted) return;
    if (_url != null || _opening || !_online || !_device.cameraHasImage) return;
    _liveAutoStarted = true;
    _startLive();
  }

  String _message(Object error) => error is CameraApiException
      ? AppErrorMapper.messageForCode(error.code)
      : AppErrorMapper.mapError(error);

  Future<void> _stopSession() async {
    setState(() {
      _url = null;
      _sessionError = null;
      _playbackFrom = null;
      _playbackTo = null;
    });
    await _holder.close();
  }

  Future<void> _startLive() async {
    final resource = _device.cameraResource('live_stream');
    if (resource == null) {
      setState(() => _sessionError = 'Bạn không có quyền xem camera này.');
      return;
    }
    setState(() {
      _opening = true;
      _sessionError = null;
      _url = null;
    });
    try {
      final session = await _holder.open(
        _device.mac,
        instanceId: resource.instanceId,
        resourceId: resource.definition.id,
      );
      if (!mounted || _mode != CameraViewMode.live) return;
      setState(() => _url = session.playlistUrl);
    } catch (error) {
      if (mounted) setState(() => _sessionError = _message(error));
    } finally {
      if (mounted) setState(() => _opening = false);
    }
  }

  Future<void> _switchMode(CameraViewMode mode) async {
    if (mode == _mode) return;
    setState(() => _mode = mode);
    await _stopSession();
    if (!mounted) return;
    if (mode == CameraViewMode.live) {
      _liveAutoStarted = false;
      _maybeAutoStartLive();
    } else {
      // Always re-read: a recording may have been made since the last visit.
      await _loadRanges(focus: true);
    }
  }

  /// Reads the day's recordings. [focus] moves the timeline to the latest one;
  /// [silent] refreshes without a progress bar.
  Future<void> _loadRanges({bool focus = false, bool silent = false}) async {
    final recording = _device.cameraResource('recording_playback');
    if (recording == null) {
      setState(() => _rangesError = 'Bạn không có quyền xem lại camera này.');
      return;
    }
    // Background refreshes never overlap; a user action always loads.
    if (silent && _rangesInFlight) return;
    _rangesInFlight = true;
    if (!silent) {
      setState(() {
        _loadingRanges = true;
        _rangesError = null;
      });
    }
    final day = _day;
    try {
      final ranges = await _api.listRecordings(
        _device.mac,
        instanceId: recording.instanceId,
        from: _day,
        to: _day.add(const Duration(days: 1)),
      );
      // The day may have changed while the camera answered.
      if (mounted && day == _day) {
        setState(() {
          _ranges = ranges;
          _rangesError = null;
          if (focus) _focusLatest();
        });
      }
    } catch (error) {
      if (mounted && !silent) setState(() => _rangesError = _message(error));
    } finally {
      _rangesInFlight = false;
      if (mounted && !silent) setState(() => _loadingRanges = false);
    }
  }

  Future<void> _changeDay(DateTime day) async {
    setState(() {
      _day = DateTime(day.year, day.month, day.day);
      _ranges = const [];
      _cursor = null;
      _span = const Duration(hours: 24);
      _windowStart = _day;
    });
    await _stopSession();
    await _loadRanges(focus: true);
  }

  /// Stretches the ruler so the latest recording fills about a third of it
  /// (a 5-minute clip gets a 15-minute window); the whole day when empty.
  void _focusLatest() {
    if (_ranges.isEmpty) {
      _span = kMaxTimelineSpan;
      _windowStart = _day;
      return;
    }
    final latest = _ranges.reduce((a, b) => a.end.isAfter(b.end) ? a : b);
    _span = _clampSpan(latest.duration * 3, min: const Duration(minutes: 5), max: const Duration(hours: 2));
    _windowStart = _clampWindow(latest.start.subtract((_span - latest.duration) ~/ 2), _span);
  }

  Duration _clampSpan(Duration span, {Duration min = kMinTimelineSpan, Duration max = kMaxTimelineSpan}) {
    if (span < min) return min;
    if (span > max) return max;
    return span;
  }

  DateTime _clampWindow(DateTime start, Duration span) {
    final latestStart = _day.add(const Duration(days: 1)).subtract(span);
    if (start.isBefore(_day)) return _day;
    if (start.isAfter(latestStart)) return latestStart;
    return start;
  }

  void _setSpan(Duration span) {
    final current = _cursor;
    final inWindow = current != null && !current.isBefore(_windowStart) && current.isBefore(_windowStart.add(_span));
    final center = inWindow ? current : _windowStart.add(_span ~/ 2);
    setState(() {
      _span = _clampSpan(span);
      _windowStart = _clampWindow(center.subtract(_span ~/ 2), _span);
    });
  }

  /// Zooms by [factor] keeping [focus] under the finger / mouse pointer.
  void _zoom(double factor, DateTime focus) {
    final span = _clampSpan(Duration(milliseconds: (_span.inMilliseconds * factor).round()));
    if (span == _span) return;
    final ratio = span.inMilliseconds / _span.inMilliseconds;
    final offset = Duration(milliseconds: (focus.difference(_windowStart).inMilliseconds * ratio).round());
    setState(() {
      _span = span;
      _windowStart = _clampWindow(focus.subtract(offset), span);
    });
  }

  void _showLatest() => setState(_focusLatest);

  void _pan(Duration delta) {
    setState(() => _windowStart = _clampWindow(_windowStart.add(delta), _span));
  }

  Future<void> _pickDay() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _day,
      firstDate: _today().subtract(const Duration(days: 365)),
      lastDate: _today(),
      helpText: 'Chọn ngày xem lại',
    );
    if (picked != null) await _changeDay(picked);
  }

  /// Plays from [time]; reuses the open playback session when it covers it.
  Future<void> _playFrom(DateTime time) async {
    final from = _playbackFrom;
    final to = _playbackTo;
    if (_url != null && from != null && to != null && !time.isBefore(from) && time.isBefore(to)) {
      _player.seekToWallTime(time);
      setState(() => _cursor = time);
      return;
    }
    final recording = _device.cameraResource('recording_playback');
    if (recording == null) return;
    var start = time;
    final dayEnd = _day.add(const Duration(days: 1));
    final inside = _ranges.any((range) => !time.isBefore(range.start) && time.isBefore(range.end));
    if (!inside) {
      final next = _ranges.where((range) => range.start.isAfter(time)).toList()
        ..sort((a, b) => a.start.compareTo(b.start));
      if (next.isEmpty) {
        _showSnack('Không có bản ghi sau thời điểm này trong ngày.');
        return;
      }
      start = next.first.start;
    }
    final end = DateTime.now().isBefore(dayEnd) ? DateTime.now() : dayEnd;
    setState(() {
      _opening = true;
      _sessionError = null;
      _url = null;
      _cursor = start;
    });
    try {
      final session = await _holder.open(
        _device.mac,
        instanceId: recording.instanceId,
        resourceId: recording.definition.id,
        input: {
          'from': start.toUtc().toIso8601String(),
          'to': end.toUtc().toIso8601String(),
        },
      );
      if (!mounted || _mode != CameraViewMode.playback) return;
      _player.seekToWallTime(start);
      setState(() {
        _url = session.playlistUrl;
        _playbackFrom = start.subtract(const Duration(minutes: 1));
        _playbackTo = end;
      });
    } catch (error) {
      if (mounted) setState(() => _sessionError = _message(error));
    } finally {
      if (mounted) setState(() => _opening = false);
    }
  }

  Future<void> _confirmDelete({required bool all}) async {
    final recording = _device.cameraResource('recording_playback');
    if (recording == null) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(all ? 'Xóa toàn bộ bản ghi?' : 'Xóa bản ghi của ngày này?'),
        content: Text(
          all
              ? 'Mọi bản ghi trên bộ nhớ camera sẽ bị xóa vĩnh viễn. Đoạn đang ghi không bị ảnh hưởng.'
              : 'Các bản ghi của ${formatDay(_day)} sẽ bị xóa vĩnh viễn.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('Hủy'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: Theme.of(dialogContext).colorScheme.error,
              foregroundColor: Theme.of(dialogContext).colorScheme.onError,
            ),
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('Xóa'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    setState(() => _deleting = true);
    await _stopSession();
    try {
      final result = await _api.deleteRecordings(
        _device.mac,
        instanceId: recording.instanceId,
        all: all,
        from: all ? null : _day,
        to: all ? null : _day.add(const Duration(days: 1)),
      );
      _showSnack(result.deletedSegments == 0
          ? 'Không có bản ghi nào để xóa.'
          : 'Đã xóa ${result.deletedSegments} phút ghi hình (${formatBytes(result.freedBytes)}).');
      await _loadRanges();
    } catch (error) {
      _showSnack(_message(error));
    } finally {
      if (mounted) setState(() => _deleting = false);
    }
  }

  void _showSnack(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
  }

  String _idleMessage() {
    if (_mode == CameraViewMode.playback) return 'Chọn một thời điểm trên dòng thời gian để xem lại';
    if (!_online) return 'Camera đang ngoại tuyến';
    if (!_device.cameraHasImage) return 'Camera chưa có hình ảnh';
    return 'Đang chờ camera';
  }

  @override
  Widget build(BuildContext context) {
    // Keeps the auto-dispose API (and its Dio) alive while the page is open.
    ref.watch(cameraApiProvider);
    final live = _mode == CameraViewMode.live;
    return ListView(
      padding: const EdgeInsets.only(top: AppSpacing.md, bottom: 100),
      children: [
        _VideoStage(
          url: _url,
          live: live,
          controller: _player,
          opening: _opening,
          error: _sessionError,
          idleMessage: _idleMessage(),
          viewers: _device.liveViewers,
          cursor: _cursor,
          onRetry: live && _online ? _startLive : null,
        ),
        const SizedBox(height: AppSpacing.md),
        _StateStrip(device: _device),
        const SizedBox(height: AppSpacing.lg),
        SegmentedButton<CameraViewMode>(
          showSelectedIcon: false,
          segments: const [
            ButtonSegment(
              value: CameraViewMode.live,
              icon: Icon(Icons.sensors_rounded),
              label: Text('Trực tiếp'),
            ),
            ButtonSegment(
              value: CameraViewMode.playback,
              icon: Icon(Icons.history_rounded),
              label: Text('Xem lại'),
            ),
          ],
          selected: {_mode},
          onSelectionChanged: (selection) => _switchMode(selection.first),
        ),
        const SizedBox(height: AppSpacing.md),
        if (!live)
          _PlaybackSection(
            day: _day,
            windowStart: _windowStart,
            span: _span,
            onSpan: _setSpan,
            onPan: _pan,
            onZoom: _zoom,
            onShowLatest: _showLatest,
            ranges: _ranges,
            cursor: _cursor,
            loading: _loadingRanges,
            error: _rangesError,
            onPreviousDay: () => _changeDay(_day.subtract(const Duration(days: 1))),
            onNextDay: _day.isBefore(_today())
                ? () => _changeDay(_day.add(const Duration(days: 1)))
                : null,
            onPickDay: _pickDay,
            onRefresh: () => _loadRanges(),
            onSelect: _playFrom,
          ),
        if (!live && _device.canManageRecordings) ...[
          const SizedBox(height: AppSpacing.lg),
          _ManageRecordings(
            deleting: _deleting,
            hasRecordingsToday: _ranges.isNotEmpty,
            onDeleteDay: () => _confirmDelete(all: false),
            onDeleteAll: () => _confirmDelete(all: true),
          ),
        ],
      ],
    );
  }
}

// ---------------------------------------------------------------- video stage

class _VideoStage extends StatelessWidget {
  const _VideoStage({
    required this.url,
    required this.live,
    required this.controller,
    required this.opening,
    required this.error,
    required this.idleMessage,
    required this.viewers,
    required this.cursor,
    this.onRetry,
  });

  final String? url;
  final bool live;
  final HlsVideoController controller;
  final bool opening;
  final String? error;
  final String idleMessage;
  final int viewers;
  final DateTime? cursor;
  final Future<void> Function()? onRetry;

  @override
  Widget build(BuildContext context) {
    final playerError = url != null && controller.phase == HlsPlayerPhase.error
        ? controller.errorMessage
        : null;
    final message = error ?? playerError;
    final buffering = url != null &&
        (controller.phase == HlsPlayerPhase.loading || controller.phase == HlsPlayerPhase.idle);
    Widget? center;
    if (opening || (buffering && message == null)) {
      center = const SizedBox(
        width: 36,
        height: 36,
        child: CircularProgressIndicator(strokeWidth: 3, color: Colors.white),
      );
    } else if (message != null) {
      center = _StageMessage(
        icon: Icons.videocam_off_rounded,
        text: message,
        action: onRetry == null
            ? null
            : TextButton.icon(
                style: TextButton.styleFrom(foregroundColor: Colors.white),
                onPressed: onRetry,
                icon: const Icon(Icons.refresh_rounded),
                label: const Text('Thử lại'),
              ),
      );
    } else if (url == null) {
      center = _StageMessage(
        icon: live ? Icons.videocam_off_rounded : Icons.touch_app_rounded,
        text: idleMessage,
      );
    } else if (controller.phase == HlsPlayerPhase.waitingForGesture ||
        (!live && controller.phase == HlsPlayerPhase.paused)) {
      center = _RoundButton(icon: Icons.play_arrow_rounded, size: 56, onTap: controller.play);
    }
    final showControls = url != null && message == null;
    return ClipRRect(
      borderRadius: BorderRadius.circular(AppRadius.lg),
      child: AspectRatio(
        aspectRatio: 16 / 9,
        child: ColoredBox(
          color: const Color(0xFF0E0F12),
          child: Stack(
            fit: StackFit.expand,
            children: [
              if (url != null)
                HlsVideoView(key: ValueKey(url), url: url!, controller: controller, live: live),
              if (center != null)
                ColoredBox(
                  color: url == null ? Colors.transparent : Colors.black38,
                  child: Center(child: center),
                ),
              if (showControls) ...[
                Positioned(
                  left: AppSpacing.smMd,
                  top: AppSpacing.smMd,
                  child: live
                      ? const _Pill(dot: Colors.redAccent, text: 'TRỰC TIẾP')
                      : _Pill(text: cursor == null ? 'XEM LẠI' : formatClock(cursor!)),
                ),
                if (live && viewers > 0)
                  Positioned(
                    right: AppSpacing.smMd,
                    top: AppSpacing.smMd,
                    child: _Pill(icon: Icons.visibility_rounded, text: '$viewers'),
                  ),
                Positioned(
                  left: 0,
                  right: 0,
                  bottom: 0,
                  child: _ControlBar(controller: controller, live: live),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _ControlBar extends StatelessWidget {
  const _ControlBar({required this.controller, required this.live});

  final HlsVideoController controller;
  final bool live;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: const BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.bottomCenter,
          end: Alignment.topCenter,
          colors: [Color(0x99000000), Color(0x00000000)],
        ),
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(AppSpacing.xs, AppSpacing.lg, AppSpacing.xs, AppSpacing.xs),
        child: Row(
          children: [
            if (!live)
              _BarIcon(
                tooltip: controller.isPlaying ? 'Tạm dừng' : 'Phát',
                icon: controller.isPlaying ? Icons.pause_rounded : Icons.play_arrow_rounded,
                onTap: controller.isPlaying ? controller.pause : controller.play,
              ),
            const Spacer(),
            _BarIcon(
              tooltip: controller.muted ? 'Bật tiếng' : 'Tắt tiếng',
              icon: controller.muted ? Icons.volume_off_rounded : Icons.volume_up_rounded,
              onTap: controller.toggleMuted,
            ),
            _BarIcon(
              tooltip: 'Toàn màn hình',
              icon: Icons.fullscreen_rounded,
              onTap: controller.enterFullscreen,
            ),
          ],
        ),
      ),
    );
  }
}

class _BarIcon extends StatelessWidget {
  const _BarIcon({required this.tooltip, required this.icon, required this.onTap});

  final String tooltip;
  final IconData icon;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => IconButton(
        tooltip: tooltip,
        onPressed: onTap,
        icon: Icon(icon, color: Colors.white),
      );
}

class _RoundButton extends StatelessWidget {
  const _RoundButton({required this.icon, required this.size, required this.onTap});

  final IconData icon;
  final double size;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Material(
        color: Colors.white.withValues(alpha: 0.18),
        shape: const CircleBorder(),
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: onTap,
          child: SizedBox(
            width: size,
            height: size,
            child: Icon(icon, color: Colors.white, size: size * 0.6),
          ),
        ),
      );
}

class _Pill extends StatelessWidget {
  const _Pill({required this.text, this.dot, this.icon});

  final String text;
  final Color? dot;
  final IconData? icon;

  @override
  Widget build(BuildContext context) => DecoratedBox(
        decoration: BoxDecoration(
          color: Colors.black.withValues(alpha: 0.45),
          borderRadius: BorderRadius.circular(AppRadius.full),
        ),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (dot != null) ...[
                DecoratedBox(
                  decoration: BoxDecoration(color: dot, shape: BoxShape.circle),
                  child: const SizedBox(width: 7, height: 7),
                ),
                const SizedBox(width: 6),
              ],
              if (icon != null) ...[
                Icon(icon, size: 14, color: Colors.white),
                const SizedBox(width: 4),
              ],
              Text(
                text,
                style: const TextStyle(
                  color: Colors.white,
                  fontSize: 11,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 0.4,
                  fontFeatures: [FontFeature.tabularFigures()],
                ),
              ),
            ],
          ),
        ),
      );
}

class _StageMessage extends StatelessWidget {
  const _StageMessage({required this.icon, required this.text, this.action});

  final IconData icon;
  final String text;
  final Widget? action;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.all(AppSpacing.lg),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, color: Colors.white54, size: 36),
            const SizedBox(height: AppSpacing.sm),
            Text(
              text,
              textAlign: TextAlign.center,
              style: const TextStyle(color: Colors.white70, fontSize: 14),
            ),
            if (action != null) ...[
              const SizedBox(height: AppSpacing.xs),
              action!,
            ],
          ],
        ),
      );
}

// ---------------------------------------------------------------- state strip

class _StateStrip extends StatelessWidget {
  const _StateStrip({required this.device});

  final DeviceModel device;

  @override
  Widget build(BuildContext context) {
    final recording = '${device.cameraValue('recording_state')}' == 'recording';
    final audio = '${device.cameraValue('audio_state')}' == 'ok';
    final resolution = device.cameraValue('video_resolution');
    return NeuCard(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md, vertical: AppSpacing.smMd),
      child: Row(
        children: [
          Expanded(
            child: _StripItem(
              icon: recording ? Icons.fiber_manual_record_rounded : Icons.stop_circle_outlined,
              tone: recording ? context.colorScheme.error : context.colorScheme.onSurfaceVariant,
              label: 'Ghi hình',
              value: device.recordingStateLabel,
            ),
          ),
          Expanded(
            child: _StripItem(
              icon: audio ? Icons.mic_rounded : Icons.mic_off_rounded,
              tone: context.colorScheme.primary,
              label: 'Hình & tiếng',
              value: resolution == null ? '—' : '${_resolutionLabel('$resolution')}${audio ? ' · có tiếng' : ''}',
            ),
          ),
          Expanded(
            child: _StripItem(
              icon: Icons.sd_storage_rounded,
              tone: context.colorScheme.primary,
              label: 'Bộ nhớ',
              value: device.storageSummary,
            ),
          ),
        ],
      ),
    );
  }

  static String _resolutionLabel(String value) {
    final height = int.tryParse(value.split('x').last);
    if (height == null) return value;
    if (height >= 1080) return 'Full HD';
    if (height >= 720) return 'HD';
    return '${height}p';
  }
}

class _StripItem extends StatelessWidget {
  const _StripItem({required this.icon, required this.tone, required this.label, required this.value});

  final IconData icon;
  final Color tone;
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Row(
        children: [
          Icon(icon, size: 18, color: tone),
          const SizedBox(width: AppSpacing.sm),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(label, style: context.textTheme.labelSmall),
                Text(
                  value,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: context.textTheme.bodySmall?.copyWith(fontWeight: FontWeight.w700),
                ),
              ],
            ),
          ),
        ],
      );
}

// ---------------------------------------------------------------- playback

class _PlaybackSection extends StatelessWidget {
  const _PlaybackSection({
    required this.day,
    required this.windowStart,
    required this.span,
    required this.onSpan,
    required this.onPan,
    required this.onZoom,
    required this.onShowLatest,
    required this.ranges,
    required this.cursor,
    required this.loading,
    required this.error,
    required this.onPreviousDay,
    required this.onNextDay,
    required this.onPickDay,
    required this.onRefresh,
    required this.onSelect,
  });

  final DateTime day;
  final DateTime windowStart;
  final Duration span;
  final ValueChanged<Duration> onSpan;
  final ValueChanged<Duration> onPan;
  final void Function(double factor, DateTime focus) onZoom;
  final VoidCallback onShowLatest;
  final List<RecordingRange> ranges;

  static const _presets = <(String, Duration)>[
    ('24 giờ', Duration(hours: 24)),
    ('6 giờ', Duration(hours: 6)),
    ('1 giờ', Duration(hours: 1)),
    ('15 phút', Duration(minutes: 15)),
    ('5 phút', Duration(minutes: 5)),
  ];
  final DateTime? cursor;
  final bool loading;
  final String? error;
  final VoidCallback onPreviousDay;
  final VoidCallback? onNextDay;
  final VoidCallback onPickDay;
  final VoidCallback onRefresh;
  final ValueChanged<DateTime> onSelect;

  @override
  Widget build(BuildContext context) {
    final total = ranges.fold<Duration>(Duration.zero, (sum, range) => sum + range.duration);
    return NeuCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              IconButton(
                tooltip: 'Ngày trước',
                onPressed: onPreviousDay,
                icon: const Icon(Icons.chevron_left_rounded),
              ),
              Expanded(
                child: TextButton(
                  onPressed: onPickDay,
                  child: Text(formatDay(day), style: context.textTheme.titleSmall),
                ),
              ),
              IconButton(
                tooltip: 'Ngày sau',
                onPressed: onNextDay,
                icon: const Icon(Icons.chevron_right_rounded),
              ),
              IconButton(
                tooltip: 'Tải lại bản ghi',
                onPressed: loading ? null : onRefresh,
                icon: const Icon(Icons.refresh_rounded),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.xs),
          Row(
            children: [
              IconButton(
                tooltip: 'Thu nhỏ (xem dài hơn)',
                onPressed: span < kMaxTimelineSpan
                    ? () => onZoom(2, windowStart.add(span ~/ 2))
                    : null,
                icon: const Icon(Icons.zoom_out_rounded),
              ),
              Expanded(
                child: SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  child: Row(
                    children: [
                      for (final (label, preset) in _presets)
                        Padding(
                          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.xs / 2),
                          child: ChoiceChip(
                            label: Text(label),
                            selected: span == preset,
                            showCheckmark: false,
                            visualDensity: VisualDensity.compact,
                            onSelected: (_) => onSpan(preset),
                          ),
                        ),
                    ],
                  ),
                ),
              ),
              IconButton(
                tooltip: 'Phóng to (kéo dãn thời gian)',
                onPressed: span > kMinTimelineSpan
                    ? () => onZoom(0.5, windowStart.add(span ~/ 2))
                    : null,
                icon: const Icon(Icons.zoom_in_rounded),
              ),
            ],
          ),
          Row(
            children: [
              Expanded(
                child: Text(
                  '${formatShortClock(windowStart)} – ${formatShortClock(windowStart.add(span))}'
                  ' · kéo để di chuyển, chụm hoặc cuộn chuột để phóng to',
                  style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant),
                ),
              ),
              if (ranges.isNotEmpty)
                TextButton(onPressed: onShowLatest, child: const Text('Bản ghi mới nhất')),
            ],
          ),
          const SizedBox(height: AppSpacing.xs),
          Row(
            children: [
              IconButton(
                tooltip: 'Lùi thời gian',
                visualDensity: VisualDensity.compact,
                onPressed: windowStart.isAfter(day) ? () => onPan(-(span ~/ 2)) : null,
                icon: const Icon(Icons.keyboard_arrow_left_rounded),
              ),
              Expanded(
                child: RecordingTimeline(
                  start: windowStart,
                  span: span,
                  ranges: ranges,
                  cursor: cursor,
                  onSelect: onSelect,
                  onPan: onPan,
                  onZoom: onZoom,
                ),
              ),
              IconButton(
                tooltip: 'Tiến thời gian',
                visualDensity: VisualDensity.compact,
                onPressed: windowStart.add(span).isBefore(day.add(const Duration(days: 1)))
                    ? () => onPan(span ~/ 2)
                    : null,
                icon: const Icon(Icons.keyboard_arrow_right_rounded),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.xs),
          const RecordingLegend(),
          const SizedBox(height: AppSpacing.xs),
          if (loading)
            const LinearProgressIndicator(minHeight: 2)
          else if (error != null)
            Row(
              children: [
                Expanded(
                  child: Text(error!, style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.error)),
                ),
                TextButton(onPressed: onRefresh, child: const Text('Thử lại')),
              ],
            )
          else
            Text(
              ranges.isEmpty
                  ? 'Không có bản ghi trong ngày này'
                  : 'Đã ghi ${formatDuration(total)} trong ngày',
              textAlign: TextAlign.center,
              style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant),
            ),
          if (ranges.isNotEmpty) ...[
            const SizedBox(height: AppSpacing.md),
            SizedBox(
              height: 40,
              child: ListView.separated(
                scrollDirection: Axis.horizontal,
                itemCount: ranges.length,
                separatorBuilder: (_, __) => const SizedBox(width: AppSpacing.sm),
                itemBuilder: (context, index) {
                  final range = ranges[ranges.length - 1 - index];
                  final active = cursor != null && !cursor!.isBefore(range.start) && cursor!.isBefore(range.end);
                  return ChoiceChip(
                    selected: active,
                    showCheckmark: false,
                    label: Text('${formatShortClock(range.start)} – ${formatShortClock(range.end)}'),
                    onSelected: (_) => onSelect(range.start),
                  );
                },
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _ManageRecordings extends StatelessWidget {
  const _ManageRecordings({
    required this.deleting,
    required this.hasRecordingsToday,
    required this.onDeleteDay,
    required this.onDeleteAll,
  });

  final bool deleting;
  final bool hasRecordingsToday;
  final VoidCallback onDeleteDay;
  final VoidCallback onDeleteAll;

  @override
  Widget build(BuildContext context) => NeuCard(
        padding: const EdgeInsets.symmetric(vertical: AppSpacing.xs),
        child: Column(
          children: [
            ListTile(
              enabled: !deleting && hasRecordingsToday,
              leading: const Icon(Icons.delete_outline_rounded),
              title: const Text('Xóa bản ghi của ngày này'),
              onTap: onDeleteDay,
            ),
            const Divider(height: 1, indent: AppSpacing.md, endIndent: AppSpacing.md),
            ListTile(
              enabled: !deleting,
              leading: Icon(Icons.delete_forever_rounded, color: context.colorScheme.error),
              title: Text('Xóa toàn bộ bản ghi', style: TextStyle(color: context.colorScheme.error)),
              onTap: onDeleteAll,
            ),
          ],
        ),
      );
}
