import 'package:flutter/foundation.dart';

enum HlsPlayerPhase { idle, loading, playing, paused, waitingForGesture, error }

/// Implemented by the platform view that actually plays the stream.
abstract interface class HlsPlaybackBinding {
  void play();
  void pause();
  void setMuted(bool muted);
  void enterFullscreen();
  void seekToWallTime(DateTime time);
  DateTime? currentWallTime();
}

/// UI-facing state and commands of one HLS player. The player starts muted,
/// like most camera apps, so autoplay is never blocked by the browser.
class HlsVideoController extends ChangeNotifier {
  HlsPlayerPhase _phase = HlsPlayerPhase.idle;
  String? _error;
  bool _muted = true;
  HlsPlaybackBinding? _binding;
  DateTime? _pendingSeek;

  HlsPlayerPhase get phase => _phase;
  String? get errorMessage => _error;
  bool get muted => _muted;
  bool get isPlaying => _phase == HlsPlayerPhase.playing;

  /// Wall-clock time of the frame on screen (playback sessions only).
  DateTime? get currentWallTime => _binding?.currentWallTime();

  void play() => _binding?.play();
  void pause() => _binding?.pause();
  void enterFullscreen() => _binding?.enterFullscreen();

  void toggleMuted() {
    _muted = !_muted;
    _binding?.setMuted(_muted);
    notifyListeners();
  }

  /// Seeks within the open playback playlist; applied once it has loaded.
  void seekToWallTime(DateTime time) {
    final binding = _binding;
    if (binding == null) {
      _pendingSeek = time;
    } else {
      binding.seekToWallTime(time);
    }
  }

  void attach(HlsPlaybackBinding binding) {
    _binding = binding;
    binding.setMuted(_muted);
  }

  void detach(HlsPlaybackBinding binding) {
    if (_binding == binding) _binding = null;
  }

  DateTime? takePendingSeek() {
    final seek = _pendingSeek;
    _pendingSeek = null;
    return seek;
  }

  void report(HlsPlayerPhase phase, [String? error]) {
    if (_phase == phase && _error == error) return;
    _phase = phase;
    _error = error;
    notifyListeners();
  }
}
