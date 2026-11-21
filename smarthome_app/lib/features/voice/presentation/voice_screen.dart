import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons/lucide_icons.dart';

import '../../../core/core.dart';
import '../../../core/navigation/app_routes.dart';
import '../../../core/utils/app_error_mapper.dart';
import '../../../core/utils/time_format.dart';
import '../../../core/widgets/widgets.dart';
import '../../profile/widgets/password_field.dart';
import '../../profile/widgets/profile_section.dart';
import '../data/voice_models.dart';
import '../providers/voice_providers.dart';
import 'voice_session_screen.dart';

/// "Giọng nói": register the owner's voice so spoken commands can be checked
/// to come from the account owner (1:1 verification, with anti-spoofing).
class VoiceScreen extends ConsumerStatefulWidget {
  const VoiceScreen({super.key});

  @override
  ConsumerState<VoiceScreen> createState() => _VoiceScreenState();
}

class _VoiceScreenState extends ConsumerState<VoiceScreen> {
  Timer? _poll;

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  /// While the anti-spoof model retrains in the background, refresh every few seconds.
  void _pollWhileTraining(VoiceState state) {
    final training = state.profile?.antiSpoofTraining ?? false;
    if (training && _poll == null) {
      _poll = Timer.periodic(const Duration(seconds: 5), (_) => ref.invalidate(voiceStateProvider));
    } else if (!training && _poll != null) {
      _poll?.cancel();
      _poll = null;
    }
  }

  void _open(VoiceSessionMode mode) => context.push(AppRoutes.profileVoiceSessionOf(mode.name));

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(voiceStateProvider);
    state.whenData(_pollWhileTraining);

    return PageScaffold(
      scrollable: false,
      appBar: AppBar(title: const Text('Giọng nói')),
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
      child: RefreshIndicator(
        onRefresh: () async {
          ref.invalidate(voiceStateProvider);
          try {
            await ref.read(voiceStateProvider.future);
          } catch (_) {}
        },
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.only(top: AppSpacing.sm, bottom: 120),
          children: state.when(
            loading: () => const [
              SizedBox(height: 200, child: Center(child: CircularProgressIndicator())),
            ],
            error: (error, _) => [
              EmptyState(
                icon: LucideIcons.micOff,
                title: 'Không tải được giọng nói',
                description: AppErrorMapper.mapError(error),
                actionText: 'Thử lại',
                onActionTap: () => ref.invalidate(voiceStateProvider),
              ),
            ],
            data: (data) => [
              if (data.lock.locked) _LockBanner(lock: data.lock),
              if (data.profile == null)
                _Intro(onStart: data.lock.locked ? null : () => _open(VoiceSessionMode.enroll))
              else ...[
                _ProfileCard(profile: data.profile!),
                const SizedBox(height: AppSpacing.lg),
                _Actions(
                  profile: data.profile!,
                  locked: data.lock.locked,
                  onOpen: _open,
                  onDelete: () => _confirmDelete(context),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _confirmDelete(BuildContext context) async {
    final deleted = await showDialog<bool>(context: context, builder: (_) => const _DeleteVoiceDialog());
    if (deleted == true && context.mounted) {
      ref.invalidate(voiceStateProvider);
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Đã xóa giọng nói của bạn')));
    }
  }
}

class _LockBanner extends StatelessWidget {
  const _LockBanner({required this.lock});

  final VoiceLock lock;

  @override
  Widget build(BuildContext context) {
    final color = context.colorScheme.error;
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.md),
      child: NeuCard(
        child: Row(
          children: [
            Icon(LucideIcons.lock, color: color),
            const SizedBox(width: AppSpacing.sm),
            Expanded(
              child: Text(
                'Xác minh giọng nói đang tạm khóa đến ${TimeFormat.clock(lock.lockedUntil!)} '
                'vì có nhiều lần không khớp liên tiếp.',
                style: TextStyle(color: color),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Intro extends StatelessWidget {
  const _Intro({required this.onStart});

  final VoidCallback? onStart;

  @override
  Widget build(BuildContext context) {
    return NeuCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Icon(LucideIcons.fingerprint, size: 40, color: context.colorScheme.primary),
          const SizedBox(height: AppSpacing.sm),
          Text('Đăng ký giọng nói', style: context.textTheme.titleLarge, textAlign: TextAlign.center),
          const SizedBox(height: AppSpacing.sm),
          for (final line in const [
            'Ứng dụng học cách nhận ra giọng của bạn từ 3 câu nói ngắn (khoảng 1 phút).',
            'Khi ra lệnh bằng giọng nói, hệ thống kiểm tra đúng là bạn, không phải người khác hay bản ghi phát lại.',
            'Chỉ lưu đặc trưng giọng nói và vài đoạn âm thanh 2 giây; bạn có thể xóa bất cứ lúc nào.',
          ])
            Padding(
              padding: const EdgeInsets.only(top: AppSpacing.xs),
              child: Text('•  $line', style: context.textTheme.bodyMedium),
            ),
          const SizedBox(height: AppSpacing.md),
          FilledButton.icon(
            onPressed: onStart,
            icon: const Icon(LucideIcons.mic, size: 18),
            label: const Text('Bắt đầu đăng ký'),
          ),
        ],
      ),
    );
  }
}

class _ProfileCard extends StatelessWidget {
  const _ProfileCard({required this.profile});

  final VoiceProfile profile;

  @override
  Widget build(BuildContext context) {
    final muted = context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant);
    final lines = <(IconData, String)>[
      (LucideIcons.userCheck, 'Đã đăng ký${profile.createdAt == null ? '' : ' lúc ${TimeFormat.dateTime(profile.createdAt!)}'}'),
      (
        LucideIcons.slidersHorizontal,
        profile.calibratedAt == null
            ? 'Chưa hiệu chỉnh độ nhạy (đang dùng ngưỡng mặc định)'
            : 'Đã hiệu chỉnh lúc ${TimeFormat.dateTime(profile.calibratedAt!)}',
      ),
      (
        LucideIcons.mic2,
        '${profile.templates} mẫu giọng: ${profile.enrollTemplates} đăng ký · ${profile.sampleTemplates} bổ sung · '
            '${profile.autoTemplates} tự học (tối đa ${profile.maxTemplates})',
      ),
      (
        profile.antiSpoofWeak ? LucideIcons.shieldAlert : LucideIcons.shieldCheck,
        profile.antiSpoofTraining
            ? 'Chống giả mạo: đang học lại…'
            : 'Chống giả mạo: phiên bản ${profile.antiSpoofVersion}, đã học ${profile.spoofClips} bản phát lại'
                '${profile.antiSpoofWeak ? ' (còn yếu, nên dạy thêm)' : ''}',
      ),
      (
        LucideIcons.info,
        '30 ngày qua: ${profile.acceptedRecently} lần khớp · ${profile.rejectedRecently} lần không khớp · '
            'so khớp ${profile.thresholds.normalized ? 'có chuẩn hóa AS-norm' : 'cosine'}',
      ),
    ];
    return NeuCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Icon(LucideIcons.fingerprint, color: context.neu.successColor),
              const SizedBox(width: AppSpacing.sm),
              Text('Giọng nói đã sẵn sàng', style: context.textTheme.titleMedium),
            ],
          ),
          const SizedBox(height: AppSpacing.sm),
          for (final (icon, text) in lines)
            Padding(
              padding: const EdgeInsets.only(top: AppSpacing.xs),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(icon, size: 16, color: context.colorScheme.onSurfaceVariant),
                  const SizedBox(width: AppSpacing.sm),
                  Expanded(child: Text(text, style: muted)),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

class _Actions extends StatelessWidget {
  const _Actions({required this.profile, required this.locked, required this.onOpen, required this.onDelete});

  final VoiceProfile profile;
  final bool locked;
  final void Function(VoiceSessionMode mode) onOpen;
  final VoidCallback onDelete;

  @override
  Widget build(BuildContext context) {
    VoidCallback? open(VoiceSessionMode mode) => locked ? null : () => onOpen(mode);
    return Column(
      children: [
        ProfileSection(
          title: 'Kiểm tra & cải thiện',
          children: [
            ProfileTile(
              icon: LucideIcons.mic,
              title: 'Thử giọng nói',
              subtitle: 'Xem hệ thống có nhận ra bạn không',
              onTap: open(VoiceSessionMode.verify),
            ),
            ProfileTile(
              icon: LucideIcons.slidersHorizontal,
              title: 'Hiệu chỉnh độ nhạy',
              subtitle: 'Đọc 3 câu để chỉnh ngưỡng theo giọng của bạn',
              onTap: open(VoiceSessionMode.calibrate),
            ),
            ProfileTile(
              icon: LucideIcons.plus,
              title: 'Thêm mẫu giọng',
              subtitle: 'Khi bị cảm, đổi điện thoại hoặc hay bị từ chối nhầm',
              onTap: open(VoiceSessionMode.sample),
            ),
            ProfileTile(
              icon: LucideIcons.speaker,
              title: 'Dạy chống giả mạo',
              subtitle: 'Ghi giọng bạn phát lại từ loa khác để hệ thống học cách từ chối',
              onTap: profile.spoofClips >= profile.maxSpoofClips ? null : open(VoiceSessionMode.replay),
            ),
          ],
        ),
        ProfileSection(
          title: 'Dữ liệu',
          children: [
            ProfileTile(
              icon: LucideIcons.trash2,
              title: 'Xóa giọng nói',
              subtitle: 'Xóa toàn bộ đặc trưng và mẫu giọng đã lưu',
              destructive: true,
              onTap: onDelete,
            ),
          ],
        ),
      ],
    );
  }
}

/// Deleting the voiceprint asks for the password (someone holding the
/// unlocked phone must not be able to swap in their own voice).
class _DeleteVoiceDialog extends ConsumerStatefulWidget {
  const _DeleteVoiceDialog();

  @override
  ConsumerState<_DeleteVoiceDialog> createState() => _DeleteVoiceDialogState();
}

class _DeleteVoiceDialogState extends ConsumerState<_DeleteVoiceDialog> {
  final _password = TextEditingController();
  bool _deleting = false;
  String? _error;

  @override
  void dispose() {
    _password.dispose();
    super.dispose();
  }

  Future<void> _delete() async {
    if (_password.text.isEmpty) {
      setState(() => _error = 'Nhập mật khẩu để xác nhận');
      return;
    }
    setState(() {
      _deleting = true;
      _error = null;
    });
    try {
      await ref.read(voiceApiProvider).delete(password: _password.text);
      if (mounted) Navigator.of(context).pop(true);
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _deleting = false;
        _error = AppErrorMapper.codeOf(error) == 'INVALID_PASSWORD'
            ? 'Mật khẩu không đúng'
            : AppErrorMapper.mapError(error);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Xóa giọng nói?'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text('Muốn dùng lại, bạn sẽ phải đăng ký giọng nói từ đầu.'),
          const SizedBox(height: AppSpacing.md),
          PasswordField(
            controller: _password,
            label: 'Mật khẩu',
            errorText: _error,
            enabled: !_deleting,
            autofocus: true,
            textInputAction: TextInputAction.done,
            onSubmitted: (_) => _delete(),
          ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: _deleting ? null : () => Navigator.of(context).pop(false),
          child: const Text('Hủy'),
        ),
        FilledButton(
          style: FilledButton.styleFrom(
            backgroundColor: context.colorScheme.error,
            foregroundColor: context.colorScheme.onError,
          ),
          onPressed: _deleting ? null : _delete,
          child: _deleting
              ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
              : const Text('Xóa'),
        ),
      ],
    );
  }
}
