import 'dart:async';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/core.dart';
import '../../../core/utils/app_error_mapper.dart';
import '../../../core/widgets/widgets.dart';
import '../audio/voice_audio.dart';
import '../audio/voice_recorder.dart';
import '../data/voice_api.dart';
import '../data/voice_models.dart';
import '../providers/voice_providers.dart';
import '../voice_texts.dart';
import '../widgets/record_step_card.dart';
import '../widgets/verification_result_card.dart';

/// What a voice session records and where it sends it.
enum VoiceSessionMode {
  enroll('Đăng ký giọng nói', 'Hoàn tất đăng ký'),
  verify('Thử giọng nói', 'Kiểm tra'),
  calibrate('Hiệu chỉnh độ nhạy', 'Hiệu chỉnh'),
  sample('Thêm mẫu giọng', 'Thêm mẫu'),
  replay('Dạy chống giả mạo', 'Gửi để học');

  const VoiceSessionMode(this.title, this.action);

  final String title;
  final String action;

  static VoiceSessionMode? parse(String? value) =>
      VoiceSessionMode.values.where((mode) => mode.name == value).firstOrNull;
}

enum _Kind { ambient, speech, replay }

class _Step {
  _Step(this.kind, this.rule, [this.sentence]);

  final _Kind kind;
  final VoiceRule rule;
  final String? sentence;
  Int16List? pcm;
  String? problem;
  String? summary;
  double? noiseRms;

  bool get done => pcm != null && problem == null;
}

const _ambientLength = Duration(seconds: 2);
const _maxLength = Duration(seconds: 10);

/// Records the takes of one voice action (enroll, verify, calibrate, add a
/// sample, teach replays), checks each on the phone, then uploads them.
class VoiceSessionScreen extends ConsumerStatefulWidget {
  const VoiceSessionScreen({super.key, required this.mode});

  final VoiceSessionMode mode;

  @override
  ConsumerState<VoiceSessionScreen> createState() => _VoiceSessionScreenState();
}

class _VoiceSessionScreenState extends ConsumerState<VoiceSessionScreen> {
  final _recorder = VoiceRecorder();
  final _stopwatch = Stopwatch();
  late final List<_Step> _steps = _buildSteps();
  Timer? _ticker;
  int? _recording;
  bool _stopping = false;
  bool _submitting = false;
  bool _consent = false;
  String? _error;
  VoiceVerification? _result;

  VoiceSessionMode get _mode => widget.mode;

  List<_Step> _buildSteps() => switch (widget.mode) {
        VoiceSessionMode.enroll => [
            _Step(_Kind.ambient, VoiceRule.profile),
            for (final sentence in VoiceTexts.enrollSentences) _Step(_Kind.speech, VoiceRule.profile, sentence),
          ],
        VoiceSessionMode.verify => [_Step(_Kind.speech, VoiceRule.verify, VoiceTexts.randomSentence())],
        VoiceSessionMode.calibrate => [
            for (final sentence in VoiceTexts.calibrationSentences) _Step(_Kind.speech, VoiceRule.profile, sentence),
          ],
        VoiceSessionMode.sample => [
            _Step(_Kind.speech, VoiceRule.profile,
                VoiceTexts.otherSentences[math.Random().nextInt(VoiceTexts.otherSentences.length)]),
          ],
        VoiceSessionMode.replay => [for (var i = 0; i < 3; i++) _Step(_Kind.replay, VoiceRule.spoof)],
      };

  @override
  void dispose() {
    _ticker?.cancel();
    _recorder.dispose();
    super.dispose();
  }

  Future<void> _record(int index) async {
    setState(() => _error = null);
    if (!await _recorder.hasPermission()) {
      setState(() => _error = 'Ứng dụng cần quyền dùng micro để ghi âm. Hãy cho phép trong phần Cài đặt của máy.');
      return;
    }
    final step = _steps[index];
    setState(() {
      _recording = index;
      step
        ..pcm = null
        ..problem = null
        ..summary = null;
      _result = null;
    });
    try {
      await _recorder.start();
    } catch (_) {
      setState(() {
        _recording = null;
        _error = 'Không mở được micro. Hãy đóng ứng dụng khác đang dùng micro rồi thử lại.';
      });
      return;
    }
    _stopwatch
      ..reset()
      ..start();
    _ticker = Timer.periodic(const Duration(milliseconds: 200), (_) {
      if (!mounted) return;
      setState(() {});
      final limit = step.kind == _Kind.ambient ? _ambientLength : _maxLength;
      if (_stopwatch.elapsed >= limit) _stop(index);
    });
  }

  Future<void> _stop(int index) async {
    if (_recording != index || _stopping) return;
    _stopping = true;
    _ticker?.cancel();
    _stopwatch.stop();
    final Int16List pcm;
    try {
      pcm = await _recorder.stop();
    } finally {
      _stopping = false;
    }
    if (!mounted) return;
    setState(() {
      _recording = null;
      _evaluate(_steps[index], pcm);
    });
    if (_mode == VoiceSessionMode.verify && _steps[index].done) await _submit();
  }

  void _evaluate(_Step step, Int16List pcm) {
    step.pcm = pcm;
    if (step.kind == _Kind.ambient) {
      final ambient = measureAmbient(pcm);
      step
        ..problem = ambient.problem
        ..noiseRms = ambient.noiseRms
        ..summary = ambient.noiseRms == null
            ? null
            : 'Yên tĩnh · tiếng ồn nền ${(20 * math.log(ambient.noiseRms!) / math.ln10).toStringAsFixed(0)} dB';
      return;
    }
    final noise = _mode == VoiceSessionMode.enroll ? _steps.first.noiseRms : null;
    final check = checkSpeech(pcm, step.rule, noiseRms: noise);
    step
      ..problem = check.problem
      ..summary = 'Tốt · ${(check.speechMs / 1000).toStringAsFixed(1)} giây giọng nói · '
          'độ sạch ${check.snrDb.toStringAsFixed(0)} dB';
  }

  bool get _canSubmit {
    if (_recording != null || _submitting) return false;
    if (_mode == VoiceSessionMode.enroll && !_consent) return false;
    return _mode == VoiceSessionMode.replay ? _steps.any((s) => s.done) : _steps.every((s) => s.done);
  }

  Future<void> _submit() async {
    final sent = [for (final (i, step) in _steps.indexed) if (step.done && step.kind != _Kind.ambient) i];
    final wavs = [for (final i in sent) wavBytes(_steps[i].pcm!)];
    final api = ref.read(voiceApiProvider);
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      switch (_mode) {
        case VoiceSessionMode.enroll:
          await api.enroll(ambient: wavBytes(_steps.first.pcm!), samples: wavs);
          _finish('Đã đăng ký giọng nói');
        case VoiceSessionMode.verify:
          final result = await api.verify(wavs.single);
          ref.invalidate(voiceStateProvider);
          if (mounted) setState(() => _result = result);
        case VoiceSessionMode.calibrate:
          await api.calibrate(wavs);
          _finish('Đã hiệu chỉnh độ nhạy theo giọng của bạn');
        case VoiceSessionMode.sample:
          await api.addSample(wavs.single);
          _finish('Đã thêm mẫu giọng');
        case VoiceSessionMode.replay:
          await api.addReplays(wavs);
          _finish('Đã gửi ${wavs.length} bản phát lại, hệ thống đang học lại');
      }
    } catch (error) {
      if (!mounted) return;
      final code = AppErrorMapper.codeOf(error);
      final failed = VoiceApi.failedSample(error);
      final index = failed == 'ambient'
          ? 0
          : failed is int && failed >= 0 && failed < sent.length
              ? sent[failed]
              : null;
      setState(() {
        final message = AppErrorMapper.mapError(error);
        if (index != null) {
          _steps[index].problem = message;
        } else {
          _error = message;
        }
      });
      if (code == 'VOICE_LOCKED' || code == 'VOICE_PROFILE_EXISTS' || code == 'VOICE_PROFILE_NOT_FOUND') {
        ref.invalidate(voiceStateProvider);
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  void _finish(String message) {
    ref.invalidate(voiceStateProvider);
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
    context.pop();
  }

  String get _intro => switch (_mode) {
        VoiceSessionMode.enroll =>
          'Ngồi ở chỗ yên tĩnh, cầm điện thoại cách miệng khoảng 20–30 cm và nói bằng giọng bình thường. '
              'Bước đầu đo tiếng ồn xung quanh trong 2 giây: hãy giữ im lặng.',
        VoiceSessionMode.verify =>
          'Đọc câu dưới đây. Hệ thống kiểm tra đó có đúng giọng bạn và không phải giọng phát lại từ loa.',
        VoiceSessionMode.calibrate =>
          'Đọc thêm 3 câu. Ngưỡng nhận diện được chỉnh theo giọng của bạn (trong giới hạn an toàn) '
              'để ít bị từ chối nhầm hơn.',
        VoiceSessionMode.sample =>
          'Thêm một mẫu khi giọng bạn thay đổi (bị cảm, đổi điện thoại) hoặc khi hay bị từ chối nhầm.',
        VoiceSessionMode.replay =>
          'Dùng một điện thoại hoặc loa khác phát lại giọng bạn (bản ghi âm, video, giọng máy đọc) gần micro '
              'của máy này. Hệ thống học để từ chối những bản phát lại như vậy. Ghi 1 đến 3 bản.',
      };

  String _title(_Step step, int index) => switch (step.kind) {
        _Kind.ambient => 'Đo tiếng ồn xung quanh',
        _Kind.speech => _mode == VoiceSessionMode.enroll ? 'Câu $index' : 'Câu ${index + 1}',
        _Kind.replay => 'Bản phát lại ${index + 1}',
      };

  String _instruction(_Step step) => switch (step.kind) {
        _Kind.ambient => 'Giữ im lặng trong 2 giây.',
        _Kind.speech => 'Nhấn Ghi âm, đọc câu sau rồi nhấn Dừng.',
        _Kind.replay => 'Nhấn Ghi âm, phát lại giọng bạn từ thiết bị khác, rồi nhấn Dừng.',
      };

  @override
  Widget build(BuildContext context) {
    return PageScaffold(
      scrollable: false,
      appBar: AppBar(title: Text(_mode.title)),
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
      child: ListView(
        padding: const EdgeInsets.only(top: AppSpacing.sm, bottom: 120),
        children: [
          Text(_intro, style: context.textTheme.bodyMedium?.copyWith(color: context.colorScheme.onSurfaceVariant)),
          const SizedBox(height: AppSpacing.md),
          for (final (index, step) in _steps.indexed)
            RecordStepCard(
              index: index + 1,
              title: _title(step, index),
              instruction: _instruction(step),
              sentence: step.sentence,
              recording: _recording == index,
              enabled: _recording == null && !_submitting,
              onRecord: () => _record(index),
              onStop: () => _stop(index),
              levels: _recorder.levels,
              elapsed: _stopwatch.elapsed,
              pcm: step.pcm,
              problem: step.problem,
              summary: step.summary,
              automatic: step.kind == _Kind.ambient,
            ),
          if (_mode == VoiceSessionMode.enroll)
            CheckboxListTile(
              value: _consent,
              onChanged: _submitting ? null : (value) => setState(() => _consent = value ?? false),
              controlAffinity: ListTileControlAffinity.leading,
              contentPadding: EdgeInsets.zero,
              title: const Text('Tôi đồng ý cho lưu đặc trưng giọng nói của mình'),
              subtitle: const Text(
                'Hệ thống lưu đặc trưng giọng nói và vài đoạn âm thanh ngắn (2 giây) để nhận ra bạn '
                'và chống giả mạo. Bạn có thể xóa bất cứ lúc nào.',
              ),
            ),
          if (_error != null) ...[
            const SizedBox(height: AppSpacing.sm),
            Text(_error!, style: TextStyle(color: context.colorScheme.error)),
          ],
          if (_result != null) ...[
            const SizedBox(height: AppSpacing.sm),
            VerificationResultCard(result: _result!),
          ],
          const SizedBox(height: AppSpacing.md),
          if (_mode != VoiceSessionMode.verify || (_result == null && _steps.single.done))
            FilledButton(
              onPressed: _canSubmit ? _submit : null,
              child: _submitting
                  ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                  : Text(_mode.action),
            )
          else if (_submitting)
            const Center(child: CircularProgressIndicator()),
        ],
      ),
    );
  }
}
