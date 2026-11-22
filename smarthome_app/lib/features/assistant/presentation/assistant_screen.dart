import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_tts/flutter_tts.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons/lucide_icons.dart';

import '../../../core/core.dart';
import '../../../core/navigation/app_routes.dart';
import '../../../core/utils/app_error_mapper.dart';
import '../../../core/utils/time_format.dart';
import '../../auth/providers/auth_provider.dart';
import '../../dashboard/presentation/capability_actions.dart' show requestAccountPassword;
import '../../payments/providers/payments_providers.dart';
import '../../voice/audio/voice_audio.dart';
import '../../voice/audio/voice_recorder.dart';
import '../data/assistant_models.dart';
import '../providers/assistant_chat.dart';
import '../providers/assistant_providers.dart';
import '../widgets/chat_bubble.dart';
import '../widgets/chat_order_card.dart';
import '../widgets/offer_actions.dart';

const _maxRecording = Duration(seconds: 10);
const _suggestions = [
  'Bạn làm được những gì?',
  'Cửa chính đã khóa chưa?',
  'Đóng mái che',
  'Mình nên dùng gói trợ lý nào?',
];

/// "Trợ lý": chat by typing or speaking. Commands that change something run
/// through the normal device paths; spoken ones must be the owner's voice;
/// operations the app normally confirms wait for a tap (or the password).
/// The assistant also advises on plans and sells them here: after the user
/// confirms, the order's QR appears in the chat and the result is announced.
/// Opened from a plan reminder ([renewPlan]), it starts with that plan's offer.
class AssistantScreen extends ConsumerStatefulWidget {
  const AssistantScreen({super.key, this.renewPlan});

  /// Code of a plan to offer for renewal right away.
  final String? renewPlan;

  @override
  ConsumerState<AssistantScreen> createState() => _AssistantScreenState();
}

class _AssistantScreenState extends ConsumerState<AssistantScreen> {
  final _input = TextEditingController();
  final _scroll = ScrollController();
  final _recorder = VoiceRecorder();
  final _tts = FlutterTts();
  final _stopwatch = Stopwatch();
  late final AssistantChat _chat;
  StreamSubscription<String>? _speech;
  Timer? _ticker;
  bool _recording = false;
  bool _speak = true;
  int _shown = 0;

  @override
  void initState() {
    super.initState();
    unawaited(_tts.setLanguage('vi-VN'));
    unawaited(_tts.setSpeechRate(0.5));
    _chat = ref.read(assistantChatProvider);
    _shown = _chat.entries.length;
    _speech = _chat.speech.listen(_say);
    _chat
      ..addListener(_onChat)
      ..resume();
    if (_shown > 0) _toBottom(animate: false);
    if (widget.renewPlan != null) unawaited(_offerRenewal(widget.renewPlan!));
  }

  /// The renewal offer of a plan reminder (once per open offer).
  Future<void> _offerRenewal(String code) async {
    try {
      final options = await ref.read(paymentsApiProvider).options();
      final plan = options.plans.where((item) => item.code == code).firstOrNull;
      final alreadyOffered = _chat.entries
          .any((entry) => entry.offer?.planCode == code && entry.offerState == OfferState.open);
      if (!mounted || plan == null || !options.available || alreadyOffered) return;
      _chat.offerPlan(plan);
    } catch (_) {
      // Payments unavailable: the chat opens normally.
    }
  }

  @override
  void dispose() {
    _chat.removeListener(_onChat);
    unawaited(_speech?.cancel());
    _chat.pause();
    _ticker?.cancel();
    unawaited(_tts.stop());
    unawaited(_recorder.dispose());
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _onChat() {
    if (_chat.entries.length != _shown) {
      _shown = _chat.entries.length;
      _toBottom();
    }
  }

  void _toBottom({bool animate = true}) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scroll.hasClients) return;
      final end = _scroll.position.maxScrollExtent;
      if (animate) {
        _scroll.animateTo(end, duration: const Duration(milliseconds: 250), curve: Curves.easeOut);
      } else {
        _scroll.jumpTo(end);
      }
    });
  }

  void _say(String text) {
    if (_speak && text.isNotEmpty) unawaited(_tts.speak(text));
  }

  Future<void> _sendText([String? preset]) async {
    final text = (preset ?? _input.text).trim();
    if (text.isEmpty || _chat.busy) return;
    _input.clear();
    unawaited(_tts.stop());
    await _chat.sendText(text);
  }

  Future<void> _toggleRecording() async {
    if (_recording) {
      await _finishRecording();
      return;
    }
    if (_chat.busy) return;
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
    await _chat.sendVoice(wavBytes(pcm));
  }

  Future<void> _confirm(ChatEntry entry, AssistantAction action) async {
    String? token;
    if (action.needsPassword) {
      final password = await requestAccountPassword(
        context,
        message: '"${action.kind == 'scene' ? action.target : action.label}" cần xác minh. Nhập mật khẩu tài khoản để tiếp tục.',
      );
      if (password == null) return;
      try {
        token = await ref.read(authRepositoryProvider).reauthenticate(password);
      } catch (error) {
        _snack(AppErrorMapper.mapError(error));
        return;
      }
    }
    await _chat.confirmAction(entry, action, reauthToken: token);
  }

  Future<void> _reset() async {
    unawaited(_tts.stop());
    await _chat.reset();
  }

  void _snack(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
  }

  Widget? _footer(ChatEntry entry) {
    if (entry.offer != null) {
      return OfferActions(
        offer: entry.offer!,
        state: entry.offerState,
        onBuy: (months) {
          unawaited(_tts.stop());
          unawaited(_chat.buy(entry, months));
        },
        onDismiss: () => _chat.dismissOffer(entry),
      );
    }
    if (entry.quota) return QuotaPlans(onPick: _chat.offerPlan);
    return null;
  }

  Widget _entry(ChatEntry entry, bool busy) {
    final bubble = ChatBubble(
      fromUser: entry.role == ChatRole.user,
      text: entry.text,
      actions: entry.actions,
      options: entry.options,
      error: entry.role == ChatRole.error,
      spoken: entry.spoken,
      working: entry.working,
      onConfirm: (action) => _confirm(entry, action),
      onOption: busy ? null : _sendText,
      footer: _footer(entry),
    );
    final order = entry.orderCode == null ? null : _chat.order(entry.orderCode!);
    if (order == null) return bubble;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        bubble,
        ChatOrderCard(
          order: order,
          replaced: _chat.isReplaced(order.code),
          busy: busy,
          onSimulate: () => _chat.simulate(order.code),
          onCancel: () => _chat.cancelOrder(order.code),
          onRenew: () => _chat.renew(order.code),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final chat = ref.watch(assistantChatProvider);
    final entries = chat.entries;
    final busy = chat.busy;
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
            onPressed: entries.isEmpty || busy ? null : _reset,
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
                        _planLabel(usage.plan.name, usage.expiresAt),
                        style: context.textTheme.bodySmall?.copyWith(
                          color: _endsSoon(usage.expiresAt) ? context.neu.warningColor : context.colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            Expanded(
              child: entries.isEmpty
                  ? _Welcome(onPick: _sendText)
                  : ListView.builder(
                      controller: _scroll,
                      padding: const EdgeInsets.all(AppSpacing.md),
                      itemCount: entries.length,
                      itemBuilder: (context, index) => _entry(entries[index], busy),
                    ),
            ),
            _InputBar(
              controller: _input,
              busy: busy,
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

/// A paid plan ending within three days (the reminders' window).
bool _endsSoon(DateTime? expiresAt) =>
    expiresAt != null && expiresAt.difference(DateTime.now()) < const Duration(days: 3);

String _planLabel(String name, DateTime? expiresAt) =>
    _endsSoon(expiresAt) ? 'Gói $name · hết hạn ${TimeFormat.date(expiresAt!)}' : 'Gói $name';

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
          'Gõ hoặc chạm micro để nói: hỏi bất cứ điều gì, nhờ điều khiển thiết bị, hay tư vấn và mua gói trợ lý. '
          'Ra lệnh bằng giọng nói cần đăng ký giọng nói trong Cá nhân.',
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
