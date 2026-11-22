import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_tts/flutter_tts.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons/lucide_icons.dart';

import '../../../core/core.dart';
import '../../../core/navigation/app_routes.dart';
import '../../../core/utils/app_error_mapper.dart';
import '../../auth/providers/auth_provider.dart';
import '../../dashboard/presentation/capability_actions.dart' show requestAccountPassword;
import '../../voice/audio/voice_audio.dart';
import '../../voice/audio/voice_recorder.dart';
import '../data/assistant_models.dart';
import '../providers/assistant_providers.dart';
import '../widgets/chat_bubble.dart';

class _Entry {
  _Entry.user(this.text, {this.spoken = false, this.working = false})
      : fromUser = true,
        actions = [],
        options = const [],
        error = false,
        quota = false;

  _Entry.assistant(this.text, {List<AssistantAction> actions = const [], this.options = const []})
      : fromUser = false,
        actions = [...actions],
        spoken = false,
        working = false,
        error = false,
        quota = false;

  _Entry.error(this.text, {this.quota = false})
      : fromUser = false,
        actions = [],
        options = const [],
        spoken = false,
        working = false,
        error = true;

  final bool fromUser;
  String text;
  final List<AssistantAction> actions;
  final List<String> options;
  final bool spoken;
  bool working;
  final bool error;

  /// The month's allowance is used up: offer the plans.
  final bool quota;
}

const _maxRecording = Duration(seconds: 10);
const _suggestions = [
  'Bạn làm được những gì?',
  'Cửa chính đã khóa chưa?',
  'Đóng mái che',
  'Tưới vườn 10 phút',
];

/// "Trợ lý": chat by typing or speaking. Commands that change something run
/// through the normal device paths; spoken ones must be the owner's voice;
/// operations the app normally confirms wait for a tap (or the password).
class AssistantScreen extends ConsumerStatefulWidget {
  const AssistantScreen({super.key});

  @override
  ConsumerState<AssistantScreen> createState() => _AssistantScreenState();
}

class _AssistantScreenState extends ConsumerState<AssistantScreen> {
  final _entries = <_Entry>[];
  final _input = TextEditingController();
  final _scroll = ScrollController();
  final _recorder = VoiceRecorder();
  final _tts = FlutterTts();
  final _stopwatch = Stopwatch();
  Timer? _ticker;
  bool _recording = false;
  bool _busy = false;
  bool _speak = true;

  @override
  void initState() {
    super.initState();
    unawaited(_tts.setLanguage('vi-VN'));
    unawaited(_tts.setSpeechRate(0.5));
  }

  @override
  void dispose() {
    _ticker?.cancel();
    unawaited(_tts.stop());
    unawaited(_recorder.dispose());
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _toBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(_scroll.position.maxScrollExtent,
            duration: const Duration(milliseconds: 250), curve: Curves.easeOut);
      }
    });
  }

  void _say(String text) {
    if (_speak && text.isNotEmpty) unawaited(_tts.speak(text));
  }

  void _showReply(AssistantReply reply) {
    _entries.add(_Entry.assistant(reply.reply, actions: reply.actions, options: reply.options));
    ref.invalidate(assistantUsageProvider);
    _say(reply.reply);
  }

  void _showError(Object error) {
    final code = AppErrorMapper.codeOf(error);
    _entries.add(_Entry.error(AppErrorMapper.mapError(error), quota: code == 'ASSISTANT_QUOTA_EXCEEDED'));
  }

  Future<void> _sendText([String? preset]) async {
    final text = (preset ?? _input.text).trim();
    if (text.isEmpty || _busy) return;
    _input.clear();
    unawaited(_tts.stop());
    final pending = _Entry.assistant('')..working = true;
    setState(() {
      _busy = true;
      _entries
        ..add(_Entry.user(text))
        ..add(pending);
    });
    _toBottom();
    try {
      final reply = await ref.read(assistantApiProvider).send(text);
      if (!mounted) return;
      setState(() {
        _entries.remove(pending);
        _showReply(reply);
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _entries.remove(pending);
        _showError(error);
      });
    } finally {
      if (mounted) setState(() => _busy = false);
      _toBottom();
    }
  }

  Future<void> _toggleRecording() async {
    if (_recording) {
      await _finishRecording();
      return;
    }
    if (_busy) return;
    if (!await _recorder.hasPermission()) {
      _snack('Ứng dụng cần quyền dùng micro. Hãy cho phép trong phần Cài đặt của máy.');
      return;
    }
    unawaited(_tts.stop());
    try {
      await _recorder.start();
    } catch (_) {
      _snack('Không mở được micro, hãy thử lại.');
      return;
    }
    _stopwatch
      ..reset()
      ..start();
    setState(() => _recording = true);
    _ticker = Timer.periodic(const Duration(milliseconds: 200), (_) {
      if (!mounted) return;
      setState(() {});
      if (_stopwatch.elapsed >= _maxRecording) unawaited(_finishRecording());
    });
  }

  Future<void> _finishRecording() async {
    if (!_recording) return;
    _ticker?.cancel();
    _stopwatch.stop();
    setState(() => _recording = false);
    final pcm = await _recorder.stop();
    final check = checkSpeech(pcm, VoiceRule.verify);
    if (!check.ok) {
      _snack(check.problem!);
      return;
    }
    final heard = _Entry.user('Đang nghe…', spoken: true, working: true);
    final pending = _Entry.assistant('')..working = true;
    setState(() {
      _busy = true;
      _entries
        ..add(heard)
        ..add(pending);
    });
    _toBottom();
    try {
      final reply = await ref.read(assistantApiProvider).sendVoice(wavBytes(pcm));
      if (!mounted) return;
      setState(() {
        heard
          ..text = reply.transcript ?? reply.message
          ..working = false;
        _entries.remove(pending);
        _showReply(reply);
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _entries
          ..remove(heard)
          ..remove(pending);
        _showError(error);
      });
    } finally {
      if (mounted) setState(() => _busy = false);
      _toBottom();
    }
  }

  Future<void> _confirm(_Entry entry, AssistantAction action) async {
    try {
      String? token;
      if (action.needsPassword) {
        final password = await requestAccountPassword(
          context,
          message: '"${action.kind == 'scene' ? action.target : action.label}" cần xác minh. Nhập mật khẩu tài khoản để tiếp tục.',
        );
        if (password == null) return;
        token = await ref.read(authRepositoryProvider).reauthenticate(password);
      }
      final result = await ref.read(assistantApiProvider).confirm(action.pendingId!, reauthToken: token);
      if (!mounted) return;
      setState(() {
        final index = entry.actions.indexOf(action);
        if (index >= 0) entry.actions[index] = result.action;
        _entries.add(_Entry.assistant(result.reply));
      });
      _say(result.reply);
      _toBottom();
    } catch (error) {
      if (!mounted) return;
      if (AppErrorMapper.codeOf(error) == 'ASSISTANT_PENDING_NOT_FOUND') {
        setState(() {
          final index = entry.actions.indexOf(action);
          if (index >= 0) entry.actions[index] = action.copyWith(status: 'failed', reason: 'hết hạn');
        });
      }
      _snack(AppErrorMapper.mapError(error));
    }
  }

  Future<void> _reset() async {
    unawaited(_tts.stop());
    setState(_entries.clear);
    try {
      await ref.read(assistantApiProvider).reset();
    } catch (_) {
      // The server forgets the conversation after 15 minutes anyway.
    }
  }

  void _snack(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    final usage = ref.watch(assistantUsageProvider).valueOrNull;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Trợ lý'),
        actions: [
          IconButton(
            tooltip: _speak ? 'Tắt đọc to' : 'Đọc to câu trả lời',
            icon: Icon(_speak ? LucideIcons.volume2 : LucideIcons.volumeX),
            onPressed: () {
              setState(() => _speak = !_speak);
              if (!_speak) unawaited(_tts.stop());
            },
          ),
          IconButton(
            tooltip: 'Cuộc trò chuyện mới',
            icon: const Icon(LucideIcons.rotateCcw),
            onPressed: _entries.isEmpty ? null : _reset,
          ),
        ],
      ),
      body: SafeArea(
        child: Column(
          children: [
            if (usage != null)
              InkWell(
                onTap: () => context.push(AppRoutes.profilePlans),
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.xs, AppSpacing.md, AppSpacing.sm),
                  child: Row(
                    children: [
                      Icon(LucideIcons.zap, size: 14, color: context.colorScheme.onSurfaceVariant),
                      const SizedBox(width: AppSpacing.xs),
                      Expanded(
                        child: LinearProgressIndicator(value: usage.usedFraction, minHeight: 4),
                      ),
                      const SizedBox(width: AppSpacing.sm),
                      Text(
                        'Gói ${usage.plan.name}',
                        style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant),
                      ),
                    ],
                  ),
                ),
              ),
            Expanded(
              child: _entries.isEmpty
                  ? _Welcome(onPick: _sendText)
                  : ListView.builder(
                      controller: _scroll,
                      padding: const EdgeInsets.all(AppSpacing.md),
                      itemCount: _entries.length,
                      itemBuilder: (context, index) {
                        final entry = _entries[index];
                        return ChatBubble(
                          fromUser: entry.fromUser,
                          text: entry.text,
                          actions: entry.actions,
                          options: entry.options,
                          error: entry.error,
                          spoken: entry.spoken,
                          working: entry.working,
                          onConfirm: (action) => _confirm(entry, action),
                          onOption: _busy ? null : _sendText,
                          footer: entry.quota
                              ? TextButton(
                                  onPressed: () => context.push(AppRoutes.profilePlans),
                                  child: const Text('Xem các gói'),
                                )
                              : null,
                        );
                      },
                    ),
            ),
            _InputBar(
              controller: _input,
              busy: _busy,
              recording: _recording,
              elapsed: _stopwatch.elapsed,
              levels: _recorder.levels,
              onSend: () => _sendText(),
              onMic: _toggleRecording,
            ),
          ],
        ),
      ),
    );
  }
}

class _Welcome extends StatelessWidget {
  const _Welcome({required this.onPick});

  final void Function(String text) onPick;

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(AppSpacing.lg),
      children: [
        Icon(LucideIcons.sparkles, size: 40, color: context.colorScheme.primary),
        const SizedBox(height: AppSpacing.sm),
        Text('Xin chào! Mình là trợ lý nhà.', style: context.textTheme.titleMedium, textAlign: TextAlign.center),
        const SizedBox(height: AppSpacing.xs),
        Text(
          'Hỏi mình bất cứ điều gì, hoặc nhờ điều khiển thiết bị. Chạm micro để nói; '
          'ra lệnh bằng giọng nói cần đăng ký giọng nói trong Cá nhân.',
          style: context.textTheme.bodyMedium?.copyWith(color: context.colorScheme.onSurfaceVariant),
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: AppSpacing.md),
        Wrap(
          alignment: WrapAlignment.center,
          spacing: AppSpacing.xs,
          runSpacing: AppSpacing.xs,
          children: [for (final text in _suggestions) ActionChip(label: Text(text), onPressed: () => onPick(text))],
        ),
      ],
    );
  }
}

class _InputBar extends StatelessWidget {
  const _InputBar({
    required this.controller,
    required this.busy,
    required this.recording,
    required this.elapsed,
    required this.levels,
    required this.onSend,
    required this.onMic,
  });

  final TextEditingController controller;
  final bool busy;
  final bool recording;
  final Duration elapsed;
  final Stream<double> levels;
  final VoidCallback onSend;
  final VoidCallback onMic;

  @override
  Widget build(BuildContext context) {
    final scheme = context.colorScheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.xs, AppSpacing.sm, AppSpacing.sm),
      child: Row(
        children: [
          Expanded(
            child: recording
                ? StreamBuilder<double>(
                    stream: levels,
                    builder: (context, snapshot) => Row(
                      children: [
                        Text('Đang nghe ${elapsed.inSeconds}s', style: context.textTheme.bodyMedium),
                        const SizedBox(width: AppSpacing.sm),
                        Expanded(child: LinearProgressIndicator(value: snapshot.data ?? 0, minHeight: 6)),
                      ],
                    ),
                  )
                : TextField(
                    controller: controller,
                    enabled: !busy,
                    maxLength: 500,
                    minLines: 1,
                    maxLines: 4,
                    textInputAction: TextInputAction.send,
                    onSubmitted: (_) => onSend(),
                    decoration: const InputDecoration(hintText: 'Nhắn cho trợ lý…', counterText: '', isDense: true),
                  ),
          ),
          const SizedBox(width: AppSpacing.xs),
          if (!recording)
            IconButton(
              tooltip: 'Gửi',
              onPressed: busy ? null : onSend,
              icon: const Icon(LucideIcons.send),
            ),
          IconButton.filled(
            tooltip: recording ? 'Gửi câu nói' : 'Nói với trợ lý',
            style: IconButton.styleFrom(backgroundColor: recording ? scheme.error : scheme.primary),
            onPressed: busy && !recording ? null : onMic,
            icon: Icon(recording ? LucideIcons.square : LucideIcons.mic),
          ),
        ],
      ),
    );
  }
}
