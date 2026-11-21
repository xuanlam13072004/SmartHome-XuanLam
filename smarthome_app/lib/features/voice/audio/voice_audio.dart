/// On-device checks of a recording before it is uploaded, mirroring
/// voice-service (voice-service/app/audio.py): the same frames, the same
/// thresholds and the same Vietnamese messages, so a bad take is caught at
/// once instead of after an upload.
library;

import 'dart:math' as math;
import 'dart:typed_data';

const int voiceSampleRate = 16000;
const int _frame = 400; // 25 ms
const int _hop = 160; // 10 ms

class VoiceRule {
  const VoiceRule({required this.minSpeechMs, required this.minSnrDb, required this.maxClipped});

  final int minSpeechMs;
  final double minSnrDb;
  final double maxClipped;

  /// Recordings that become part of the profile (enroll, calibrate, samples).
  static const profile = VoiceRule(minSpeechMs: 1500, minSnrDb: 12, maxClipped: 0.01);

  /// A recording to verify.
  static const verify = VoiceRule(minSpeechMs: 800, minSnrDb: 8, maxClipped: 0.01);

  /// A replay played through another speaker (naturally degraded).
  static const spoof = VoiceRule(minSpeechMs: 1000, minSnrDb: 3, maxClipped: 0.05);
}

class VoiceCheck {
  const VoiceCheck({this.problem, this.speechMs = 0, this.snrDb = 0});

  /// Why the recording cannot be used, or null when it is fine.
  final String? problem;
  final int speechMs;
  final double snrDb;

  bool get ok => problem == null;
}

double _percentile(List<double> values, double p) {
  final sorted = [...values]..sort();
  final position = p / 100 * (sorted.length - 1);
  final lower = position.floor();
  final upper = position.ceil();
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

List<double> _frameRms(Float64List x) {
  if (x.length < _frame) {
    var sum = 0.0;
    for (final v in x) {
      sum += v * v;
    }
    return [math.sqrt(sum / math.max(1, x.length) + 1e-12)];
  }
  final count = 1 + (x.length - _frame) ~/ _hop;
  return List.generate(count, (i) {
    var sum = 0.0;
    final start = i * _hop;
    for (var j = start; j < start + _frame; j++) {
      sum += x[j] * x[j];
    }
    return math.sqrt(sum / _frame + 1e-12);
  });
}

Float64List _centered(Int16List pcm) {
  final x = Float64List(pcm.length);
  var mean = 0.0;
  for (var i = 0; i < pcm.length; i++) {
    x[i] = pcm[i] / 32768.0;
    mean += x[i];
  }
  mean /= math.max(1, pcm.length);
  for (var i = 0; i < x.length; i++) {
    x[i] -= mean;
  }
  return x;
}

/// Checks a spoken sentence against [rule]; [noiseRms] is the background
/// measured by [measureAmbient] (otherwise taken from the quietest frames).
VoiceCheck checkSpeech(Int16List pcm, VoiceRule rule, {double? noiseRms}) {
  if (pcm.length < voiceSampleRate ~/ 4) {
    return const VoiceCheck(problem: 'Câu nói quá ngắn, hãy đọc hết câu.');
  }
  var clippedCount = 0;
  for (final v in pcm) {
    if (v.abs() >= 32735) clippedCount++;
  }
  final clipped = clippedCount / pcm.length;
  final rms = _frameRms(_centered(pcm));
  final noise = math.max(noiseRms ?? _percentile(rms, 10), 1e-4);
  final loud = _percentile(rms, 90);
  final snrDb = math.min(60.0, 20 * math.log(math.max(loud, 1e-9) / noise) / math.ln10);
  final threshold = math.max(2 * noise, 0.002);
  final voiced = rms.where((value) => value >= threshold).toList();
  if (voiced.isEmpty || loud < 2 * noise) {
    return VoiceCheck(problem: 'Không nghe thấy giọng nói, hãy nói to và rõ hơn.', snrDb: snrDb);
  }
  final speechMs = voiced.length * _hop * 1000 ~/ voiceSampleRate;
  final speechRms = math.sqrt(voiced.map((v) => v * v).reduce((a, b) => a + b) / voiced.length);
  String? problem;
  if (clipped > rule.maxClipped) {
    problem = 'Âm thanh bị rè vì nói quá sát micro, hãy cầm xa hơn một chút.';
  } else if (speechRms < 0.005) {
    problem = 'Giọng nói quá nhỏ, hãy nói to hơn.';
  } else if (snrDb < rule.minSnrDb) {
    problem = 'Xung quanh quá ồn, hãy tìm chỗ yên tĩnh hơn.';
  } else if (speechMs < rule.minSpeechMs) {
    problem = 'Câu nói quá ngắn, hãy đọc hết câu.';
  }
  return VoiceCheck(problem: problem, speechMs: speechMs, snrDb: snrDb);
}

/// Background level of the silent recording made before enrollment, or the
/// reason it cannot be used.
({double? noiseRms, String? problem}) measureAmbient(Int16List pcm) {
  if (pcm.length < voiceSampleRate) {
    return (noiseRms: null, problem: 'Cần giữ im lặng ít nhất 1 giây.');
  }
  final rms = _frameRms(_centered(pcm));
  final level = _percentile(rms, 50);
  if (level > 0.02 || _percentile(rms, 95) > math.max(2 * level, 0.004)) {
    return (noiseRms: null, problem: 'Xung quanh đang ồn hoặc có tiếng nói, hãy tìm chỗ yên tĩnh hơn.');
  }
  return (noiseRms: math.max(level, 1e-4), problem: null);
}

/// Joins little-endian 16-bit PCM chunks from the recorder.
Int16List pcmFromChunks(List<Uint8List> chunks) {
  final builder = BytesBuilder(copy: false);
  for (final chunk in chunks) {
    builder.add(chunk);
  }
  final bytes = builder.takeBytes();
  final data = ByteData.sublistView(bytes);
  return Int16List.fromList(List.generate(bytes.length ~/ 2, (i) => data.getInt16(i * 2, Endian.little)));
}

/// Loudness of one recorder chunk for the level meter, 0..1 (log scale, -60..0 dBFS).
double chunkLevel(Uint8List chunk) {
  if (chunk.length < 2) return 0;
  final data = ByteData.sublistView(chunk);
  var sum = 0.0;
  final count = chunk.length ~/ 2;
  for (var i = 0; i < count; i++) {
    final v = data.getInt16(i * 2, Endian.little) / 32768.0;
    sum += v * v;
  }
  final db = 20 * math.log(math.sqrt(sum / count) + 1e-9) / math.ln10;
  return ((db + 60) / 60).clamp(0.0, 1.0);
}

/// A 16-bit mono WAV file of [pcm].
Uint8List wavBytes(Int16List pcm, {int sampleRate = voiceSampleRate}) {
  final dataLength = pcm.length * 2;
  final header = ByteData(44)
    ..setUint32(0, 0x52494646) // RIFF
    ..setUint32(4, 36 + dataLength, Endian.little)
    ..setUint32(8, 0x57415645) // WAVE
    ..setUint32(12, 0x666d7420) // fmt
    ..setUint32(16, 16, Endian.little)
    ..setUint16(20, 1, Endian.little) // PCM
    ..setUint16(22, 1, Endian.little) // mono
    ..setUint32(24, sampleRate, Endian.little)
    ..setUint32(28, sampleRate * 2, Endian.little)
    ..setUint16(32, 2, Endian.little)
    ..setUint16(34, 16, Endian.little)
    ..setUint32(36, 0x64617461) // data
    ..setUint32(40, dataLength, Endian.little);
  final out = Uint8List(44 + dataLength)..setRange(0, 44, header.buffer.asUint8List());
  final body = ByteData.sublistView(out, 44);
  for (var i = 0; i < pcm.length; i++) {
    body.setInt16(i * 2, pcm[i], Endian.little);
  }
  return out;
}
