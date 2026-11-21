import 'dart:async';
import 'dart:typed_data';

import 'package:record/record.dart';

import 'voice_audio.dart';

/// Records 16 kHz mono PCM the same way for every take (enrollment and
/// verification must be comparable): no automatic gain, echo cancellation or
/// noise suppression, and the Android voice-recognition microphone path.
class VoiceRecorder {
  final AudioRecorder _recorder = AudioRecorder();
  final List<Uint8List> _chunks = [];
  final StreamController<double> _levels = StreamController<double>.broadcast();
  StreamSubscription<Uint8List>? _subscription;

  /// Loudness while recording (0..1) for the level meter.
  Stream<double> get levels => _levels.stream;

  Future<bool> hasPermission() => _recorder.hasPermission();

  Future<void> start() async {
    _chunks.clear();
    final stream = await _recorder.startStream(const RecordConfig(
      encoder: AudioEncoder.pcm16bits,
      sampleRate: voiceSampleRate,
      numChannels: 1,
      autoGain: false,
      echoCancel: false,
      noiseSuppress: false,
      androidConfig: AndroidRecordConfig(audioSource: AndroidAudioSource.voiceRecognition),
    ));
    _subscription = stream.listen((chunk) {
      _chunks.add(chunk);
      if (!_levels.isClosed) _levels.add(chunkLevel(chunk));
    });
  }

  Future<Int16List> stop() async {
    await _recorder.stop();
    await _subscription?.cancel();
    _subscription = null;
    return pcmFromChunks(_chunks);
  }

  Future<void> cancel() async {
    await _subscription?.cancel();
    _subscription = null;
    await _recorder.cancel();
    _chunks.clear();
  }

  Future<void> dispose() async {
    await _subscription?.cancel();
    await _recorder.dispose();
    await _levels.close();
  }
}
