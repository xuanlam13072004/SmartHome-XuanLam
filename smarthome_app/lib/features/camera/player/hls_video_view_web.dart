import 'dart:js_interop';
import 'dart:js_interop_unsafe';
import 'dart:ui_web' as ui_web;

import 'package:flutter/material.dart';
import 'package:web/web.dart' as web;

import 'hls_video_controller.dart';

/// hls.js (web/vendor/hls/hls.min.js, loaded by web/index.html).
@JS('Hls')
extension type _Hls._(JSObject _) implements JSObject {
  external _Hls(JSObject config);
  external static bool isSupported();
  external void loadSource(String url);
  external void attachMedia(web.HTMLMediaElement media);
  external void startLoad();
  external void recoverMediaError();
  external void destroy();
  external void on(String event, JSFunction listener);
  external JSArray<JSObject>? get levels;
  external JSObject? get playingDate;
}

bool get _hlsAvailable => globalContext.has('Hls') && _Hls.isSupported();

int _nextViewId = 0;

/// HLS player for the web app: a `<video>` element driven by hls.js. The
/// Flutter overlay draws the controls; native controls appear only in full
/// screen, where the overlay cannot be shown.
class HlsVideoView extends StatefulWidget {
  const HlsVideoView({
    super.key,
    required this.url,
    required this.controller,
    this.live = false,
  });

  final String url;
  final HlsVideoController controller;
  final bool live;

  @override
  State<HlsVideoView> createState() => _HlsVideoViewState();
}

class _HlsVideoViewState extends State<HlsVideoView> implements HlsPlaybackBinding {
  late final String _viewType = 'smarthome-hls-${_nextViewId++}';
  late final web.HTMLVideoElement _video;
  _Hls? _hls;
  int _networkRetries = 0;
  bool _levelLoaded = false;
  final List<void Function()> _removeListeners = [];

  @override
  void initState() {
    super.initState();
    _video = web.HTMLVideoElement()
      ..controls = false
      ..muted = true
      ..autoplay = true
      ..playsInline = true
      ..style.width = '100%'
      ..style.height = '100%'
      ..style.objectFit = 'contain'
      ..style.backgroundColor = 'black';
    ui_web.platformViewRegistry.registerViewFactory(_viewType, (int _) => _video);
    _listen('playing', () => widget.controller.report(HlsPlayerPhase.playing));
    _listen('pause', () {
      if (!_video.ended) widget.controller.report(HlsPlayerPhase.paused);
    });
    _listen('waiting', () => widget.controller.report(HlsPlayerPhase.loading));
    _listen('fullscreenchange', () {
      _video.controls = web.document.fullscreenElement == _video;
    });
    widget.controller.attach(this);
    _load(widget.url);
  }

  @override
  void didUpdateWidget(HlsVideoView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != widget.controller) {
      oldWidget.controller.detach(this);
      widget.controller.attach(this);
    }
    if (oldWidget.url != widget.url) _load(widget.url);
  }

  @override
  void dispose() {
    widget.controller.detach(this);
    _teardown();
    for (final remove in _removeListeners) {
      remove();
    }
    _video.removeAttribute('src');
    _video.load();
    super.dispose();
  }

  void _listen(String type, void Function() handler) {
    final listener = ((web.Event _) => handler()).toJS;
    _video.addEventListener(type, listener);
    _removeListeners.add(() => _video.removeEventListener(type, listener));
  }

  void _teardown() {
    _hls?.destroy();
    _hls = null;
  }

  void _load(String url) {
    _teardown();
    _networkRetries = 0;
    _levelLoaded = false;
    widget.controller.report(HlsPlayerPhase.loading);
    if (_hlsAvailable) {
      final config = <String, Object>{
        'enableWorker': true,
        'backBufferLength': 30,
        if (widget.live) 'liveSyncDurationCount': 2,
        if (widget.live) 'liveMaxLatencyDurationCount': 6,
        'manifestLoadingMaxRetry': 4,
        'fragLoadingMaxRetry': 4,
      }.jsify()! as JSObject;
      final hls = _Hls(config);
      _hls = hls;
      hls.on('hlsLevelLoaded', ((JSString _, JSObject __) => _onLevelLoaded()).toJS);
      hls.on('hlsError', ((JSString _, JSObject data) => _onHlsError(hls, data)).toJS);
      hls.loadSource(url);
      hls.attachMedia(_video);
      _startPlayback();
    } else if (_video.canPlayType('application/vnd.apple.mpegurl').isNotEmpty) {
      // Safari plays HLS natively.
      _video.src = url;
      _startPlayback();
    } else {
      widget.controller.report(
        HlsPlayerPhase.error,
        'Trình duyệt không hỗ trợ phát HLS.',
      );
    }
  }

  void _startPlayback() {
    _video.play().toDart.then<void>((_) {}, onError: (Object _) {
      // Autoplay with sound needs a user gesture in some browsers.
      if (mounted) widget.controller.report(HlsPlayerPhase.waitingForGesture);
    });
  }

  void _onLevelLoaded() {
    if (_levelLoaded) return;
    _levelLoaded = true;
    final pending = widget.controller.takePendingSeek();
    if (pending != null) seekToWallTime(pending);
  }

  void _onHlsError(_Hls hls, JSObject data) {
    final fatal = (data.getProperty<JSBoolean?>('fatal'.toJS))?.toDart ?? false;
    if (!fatal || hls != _hls) return;
    final type = (data.getProperty<JSString?>('type'.toJS))?.toDart ?? '';
    final response = data.getProperty<JSObject?>('response'.toJS);
    final status = (response?.getProperty<JSNumber?>('code'.toJS))?.toDartInt ?? 0;
    if (status == 403) {
      widget.controller.report(HlsPlayerPhase.error, 'Phiên xem đã hết hạn hoặc bị thu hồi.');
      return;
    }
    if (type == 'networkError' && _networkRetries < 3) {
      _networkRetries += 1;
      hls.startLoad();
      return;
    }
    if (type == 'mediaError') {
      hls.recoverMediaError();
      return;
    }
    widget.controller.report(
      HlsPlayerPhase.error,
      widget.live
          ? 'Mất luồng trực tiếp. Camera có thể đã dừng phát.'
          : 'Không phát được bản ghi này.',
    );
  }

  @override
  void play() => _startPlayback();

  @override
  void pause() => _video.pause();

  @override
  void setMuted(bool muted) {
    _video.muted = muted;
  }

  @override
  void enterFullscreen() {
    _video.requestFullscreen().toDart.then<void>((_) {}, onError: (Object _) {});
  }

  @override
  DateTime? currentWallTime() {
    final date = _hls?.playingDate;
    if (date == null) return null;
    final millis = date.callMethod<JSNumber>('getTime'.toJS).toDartDouble;
    if (millis.isNaN) return null;
    return DateTime.fromMillisecondsSinceEpoch(millis.round());
  }

  @override
  void seekToWallTime(DateTime time) {
    final levels = _hls?.levels?.toDart;
    if (levels == null || levels.isEmpty) return;
    final details = levels.first.getProperty<JSObject?>('details'.toJS);
    final fragments = details?.getProperty<JSArray<JSObject>?>('fragments'.toJS)?.toDart;
    if (fragments == null || fragments.isEmpty) return;
    final target = time.millisecondsSinceEpoch.toDouble();
    double? position;
    for (final fragment in fragments) {
      final start = fragment.getProperty<JSNumber?>('start'.toJS)?.toDartDouble;
      final duration = fragment.getProperty<JSNumber?>('duration'.toJS)?.toDartDouble ?? 0;
      final pdt = fragment.getProperty<JSNumber?>('programDateTime'.toJS)?.toDartDouble;
      if (start == null || pdt == null) continue;
      if (pdt <= target) {
        position = start + ((target - pdt) / 1000).clamp(0.0, duration);
      } else {
        position ??= start; // target is before the first recording: start there
        break;
      }
    }
    if (position != null) _video.currentTime = position;
  }

  @override
  Widget build(BuildContext context) => HtmlElementView(viewType: _viewType);
}
