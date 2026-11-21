import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:smarthome_app/features/voice/audio/voice_audio.dart';
import 'package:smarthome_app/features/voice/data/voice_models.dart';

/// A vowel-like voice between two stretches of room noise (as in voice-service tests).
Int16List voice({double f0 = 120, double seconds = 2.5, double noise = 0.001, double level = 0.2, int seed = 1}) {
  final random = math.Random(seed);
  double gauss() => math.sqrt(-2 * math.log(1 - random.nextDouble())) * math.cos(2 * math.pi * random.nextDouble());
  const pad = 6400;
  final n = (seconds * voiceSampleRate).round();
  final out = Int16List(n + 2 * pad);
  var phase = 0.0;
  for (var i = 0; i < out.length; i++) {
    var v = noise * gauss();
    final j = i - pad;
    if (j >= 0 && j < n) {
      final t = j / voiceSampleRate;
      phase += 2 * math.pi * f0 / voiceSampleRate;
      var tone = 0.0;
      for (var k = 1; k < 12; k++) {
        tone += math.sin(k * phase) / k;
      }
      final envelope = (0.55 - 0.45 * math.cos(2 * math.pi * 4 * t)).clamp(0.0, 1.0);
      v += tone / 3 * envelope * level;
    }
    out[i] = (v.clamp(-1.0, 1.0) * 32767).round();
  }
  return out;
}

Int16List silence({double seconds = 2, double noise = 0.001}) {
  final random = math.Random(9);
  return Int16List.fromList(List.generate(
    (seconds * voiceSampleRate).round(),
    (_) => ((random.nextDouble() * 2 - 1) * noise * 1.7 * 32767).round(),
  ));
}

void main() {
  test('a clean sentence passes the profile rule', () {
    final check = checkSpeech(voice(), VoiceRule.profile);
    expect(check.ok, isTrue, reason: check.problem);
    expect(check.speechMs, greaterThan(2000));
    expect(check.snrDb, greaterThan(25));
  });

  test('unusable recordings get the same messages as the server', () {
    expect(checkSpeech(silence(), VoiceRule.verify).problem, contains('Không nghe thấy'));
    expect(checkSpeech(voice(seconds: 0.5), VoiceRule.verify).problem, contains('quá ngắn'));
    expect(checkSpeech(voice(noise: 0.02), VoiceRule.profile).problem, contains('quá ồn'));
    expect(checkSpeech(voice(noise: 0.02), VoiceRule.verify).ok, isTrue);
    expect(checkSpeech(voice(level: 5), VoiceRule.profile).problem, contains('rè'));
  });

  test('ambient measurement refuses speech', () {
    final quiet = measureAmbient(silence());
    expect(quiet.problem, isNull);
    expect(quiet.noiseRms, closeTo(0.001, 0.0005));
    expect(measureAmbient(voice()).problem, isNotNull);
    expect(measureAmbient(silence(seconds: 0.5)).problem, contains('1 giây'));
  });

  test('wav header and pcm chunks round trip', () {
    final pcm = Int16List.fromList([0, 1, -1, 32767, -32768]);
    final wav = wavBytes(pcm);
    expect(String.fromCharCodes(wav.sublist(0, 4)), 'RIFF');
    expect(String.fromCharCodes(wav.sublist(8, 12)), 'WAVE');
    expect(ByteData.sublistView(wav).getUint32(24, Endian.little), 16000);
    expect(wav.length, 44 + 10);
    final bytes = wav.sublist(44);
    expect(pcmFromChunks([bytes.sublist(0, 3), bytes.sublist(3)]), pcm);
    expect(chunkLevel(Uint8List(0)), 0);
    expect(chunkLevel(wavBytes(voice()).sublist(44 + 32000, 44 + 36000)), greaterThan(0.5));
  });

  test('voice state parses profile, lock and verification', () {
    final state = VoiceState.fromJson({
      'profile': {
        'created_at': '2026-11-21T03:00:00Z',
        'calibrated_at': null,
        'noise_floor_db': -58.2,
        'thresholds': {'mode': 'as_norm', 'speaker': 0.68, 'norm': 3.0, 'fusion': 0.64, 'anti_spoof': 0.47},
        'templates': {'enroll': 3, 'sample': 1, 'auto': 2, 'max': 30},
        'anti_spoof': {'version': 2, 'training': true, 'spoof_clips': 4, 'max_spoof_clips': 20, 'weak': false},
        'attempts_30d': {'accepted': 5, 'rejected': 1},
      },
      'lock': {'locked_until': null, 'failures_left': 4},
    });
    expect(state.profile!.templates, 6);
    expect(state.profile!.thresholds.normalized, isTrue);
    expect(state.profile!.antiSpoofTraining, isTrue);
    expect(state.lock.locked, isFalse);
    expect(state.lock.failuresLeft, 4);
    expect(VoiceState.fromJson({'profile': null, 'lock': {'failures_left': 5}}).profile, isNull);

    final result = VoiceVerification.fromJson({
      'result': {
        'accepted': false,
        'reason': 'spoof_suspected',
        'scores': {'similarity': 0.81, 'normalized': null, 'anti_spoof': 0.2, 'fusion': 0.6, 'snr_db': 30.0},
        'thresholds': {'mode': 'cosine', 'speaker': 0.68, 'norm': 3.0, 'fusion': 0.64, 'anti_spoof': 0.47},
        'gallery_updated': false,
      },
      'lock': {'locked_until': DateTime.now().add(const Duration(minutes: 15)).toUtc().toIso8601String(), 'failures_left': 0},
    });
    expect(result.reason, 'spoof_suspected');
    expect(result.scores.normalized, isNull);
    expect(result.lock.locked, isTrue);
  });
}
