import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:video_player/video_player.dart';

import 'hls_playlist.dart';
import 'hls_video_controller.dart';

/// HLS player for Android / iOS: the platform player (ExoPlayer on Android)
/// through `video_player`. Recordings also read their playlist once to map
/// the player position to wall-clock time (`#EXT-X-PROGRAM-DATE-TIME`), the
/// same mapping hls.js gives the web app.
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
  static final Dio _playlistClient = Dio(BaseOptions(
    connectTimeout: const Duration(seconds: 10),
    receiveTimeout: const Duration(seconds: 10),
    responseType: ResponseType.plain,
  ));

  VideoPlayerController? _player;
  List<HlsFragment> _fragments = const [];
  bool _muted = true;
  int _generation = 0;
  int _retries = 0;
  Timer? _retryTimer;

  /// A seek asked for before the player was ready.
  DateTime? _pendingSeek;

  @override
  void initState() {
    super.initState();
    widget.controller.attach(this);
    _load();
  }

  @override
  void didUpdateWidget(HlsVideoView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != widget.controller) {
      oldWidget.controller.detach(this);
      widget.controller.attach(this);
    }
    if (oldWidget.url != widget.url) {
      _retries = 0;
      _load();
    }
  }

  @override
  void dispose() {
    widget.controller.detach(this);
    _retryTimer?.cancel();
    _generation++;
    _releasePlayer();
    super.dispose();
  }

  void _releasePlayer() {
    final player = _player;
    _player = null;
    if (player == null) return;
    player.removeListener(_onPlayerChanged);
    player.dispose();
  }

  Future<void> _load() async {
    final generation = ++_generation;
    _retryTimer?.cancel();
    _releasePlayer();
    _fragments = const [];
    widget.controller.report(HlsPlayerPhase.loading);
    if (mounted) setState(() {});

    if (!widget.live) {
      try {
        final response = await _playlistClient.get<String>(widget.url);
        if (generation != _generation) return;
        _fragments = parseHlsFragments(response.data ?? '');
      } on DioException catch (error) {
        if (generation != _generation) return;
        if (error.response?.statusCode == 403) {
          widget.controller.report(HlsPlayerPhase.error, 'Phiên xem đã hết hạn hoặc bị thu hồi.');
          return;
        }
        // The player below reports the failure (or plays without seeking).
      } catch (_) {
        // An unreadable playlist only costs the wall-clock mapping.
      }
    }

    if (generation != _generation) return;
    final player = VideoPlayerController.networkUrl(
      Uri.parse(widget.url),
      formatHint: VideoFormat.hls,
    );
    _player = player;
    try {
      await player.initialize();
    } catch (_) {
      if (generation == _generation) _onFailure(player);
      return;
    }
    if (generation != _generation || !mounted) return;
    player.addListener(_onPlayerChanged);
    final pending = _pendingSeek ?? widget.controller.takePendingSeek();
    _pendingSeek = null;
    if (pending != null) seekToWallTime(pending);
    // Not awaited: the view may be closed meanwhile, and the listener reports.
    unawaited(player.setVolume(_muted ? 0 : 1));
    unawaited(player.play());
    setState(() {});
  }

  void _onPlayerChanged() {
    final player = _player;
    if (player == null) return;
    final value = player.value;
    if (value.hasError) {
      _onFailure(player);
    } else if (value.isBuffering) {
      widget.controller.report(HlsPlayerPhase.loading);
    } else if (value.isPlaying) {
      _retries = 0;
      widget.controller.report(HlsPlayerPhase.playing);
    } else {
      widget.controller.report(HlsPlayerPhase.paused);
    }
  }

  void _onFailure(VideoPlayerController player) {
    if (player != _player) return;
    player.removeListener(_onPlayerChanged);
    final description = player.value.errorDescription ?? '';
    if (description.contains('403')) {
      widget.controller.report(HlsPlayerPhase.error, 'Phiên xem đã hết hạn hoặc bị thu hồi.');
      return;
    }
    // A live stream can drop for a moment (camera reconnecting): retry a few times.
    if (_retries < 3) {
      _retries += 1;
      widget.controller.report(HlsPlayerPhase.loading);
      final generation = _generation;
      _retryTimer = Timer(Duration(seconds: 2 * _retries), () {
        if (mounted && generation == _generation) _load();
      });
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
  void play() => _player?.play();

  @override
  void pause() => _player?.pause();

  @override
  void setMuted(bool muted) {
    _muted = muted;
    _player?.setVolume(muted ? 0 : 1);
  }

  @override
  void enterFullscreen() {
    final player = _player;
    if (player == null || !player.value.isInitialized) return;
    Navigator.of(context, rootNavigator: true).push(
      PageRouteBuilder<void>(
        opaque: true,
        pageBuilder: (_, __, ___) => _FullscreenVideo(player: player),
        transitionsBuilder: (_, animation, __, child) => FadeTransition(opacity: animation, child: child),
      ),
    );
  }

  @override
  DateTime? currentWallTime() {
    final player = _player;
    if (player == null || _fragments.isEmpty) return null;
    return wallTimeAtPosition(_fragments, player.value.position.inMicroseconds / 1e6);
  }

  @override
  void seekToWallTime(DateTime time) {
    final player = _player;
    if (player == null || !player.value.isInitialized) {
      _pendingSeek = time;
      return;
    }
    final position = positionForWallTime(_fragments, time);
    if (position != null) {
      player.seekTo(Duration(microseconds: (position * 1e6).round()));
    }
  }

  @override
  Widget build(BuildContext context) {
    final player = _player;
    return ColoredBox(
      color: Colors.black,
      child: player == null || !player.value.isInitialized
          ? const SizedBox.expand()
          : Center(
              child: AspectRatio(
                aspectRatio: player.value.aspectRatio,
                child: VideoPlayer(player),
              ),
            ),
    );
  }
}

/// Landscape, full-screen view of the same player; tap or back to leave.
class _FullscreenVideo extends StatefulWidget {
  const _FullscreenVideo({required this.player});

  final VideoPlayerController player;

  @override
  State<_FullscreenVideo> createState() => _FullscreenVideoState();
}

class _FullscreenVideoState extends State<_FullscreenVideo> {
  @override
  void initState() {
    super.initState();
    SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky);
    SystemChrome.setPreferredOrientations(const [
      DeviceOrientation.landscapeLeft,
      DeviceOrientation.landscapeRight,
    ]);
  }

  @override
  void dispose() {
    SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
    SystemChrome.setPreferredOrientations(const []);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      body: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () => Navigator.of(context).pop(),
        child: Stack(
          children: [
            Center(
              child: AspectRatio(
                aspectRatio: widget.player.value.aspectRatio,
                child: VideoPlayer(widget.player),
              ),
            ),
            SafeArea(
              child: Padding(
                padding: const EdgeInsets.all(8),
                child: IconButton(
                  tooltip: 'Thoát toàn màn hình',
                  onPressed: () => Navigator.of(context).pop(),
                  icon: const Icon(Icons.fullscreen_exit_rounded, color: Colors.white),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
