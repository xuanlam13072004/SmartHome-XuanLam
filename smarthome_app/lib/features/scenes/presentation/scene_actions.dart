import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/utils/app_error_mapper.dart';
import '../../auth/providers/auth_provider.dart';
import '../../dashboard/presentation/capability_actions.dart' show requestAccountPassword;
import '../../profile/widgets/confirm_dialog.dart';
import '../data/scene_models.dart';
import '../providers/scenes_providers.dart';
import 'scene_run_sheet.dart';

/// Runs [scene] and shows its progress. A scene with a protected step (an
/// operation the app normally confirms, e.g. unlocking a door) asks for the
/// account password first, every time. A scene already running shows that run.
Future<void> runScene(BuildContext context, WidgetRef ref, Scene scene) async {
  final messenger = ScaffoldMessenger.of(context);
  if (scene.lastRunStatus == 'running' && scene.lastRunId != null) {
    await showSceneRunSheet(context, scene.lastRunId!);
    return;
  }
  if (scene.steps.isEmpty) {
    messenger.showSnackBar(const SnackBar(content: Text('Kịch bản chưa có bước nào')));
    return;
  }
  try {
    String? reauthToken;
    if (scene.protected) {
      final sensitive = scene.steps.where((step) => step.protected).map((step) => step.label).toSet().join(', ');
      final password = await requestAccountPassword(
        context,
        message: 'Kịch bản "${scene.name}" có thao tác cần xác minh ($sensitive). Nhập mật khẩu tài khoản để chạy.',
      );
      if (password == null) return;
      reauthToken = await ref.read(authRepositoryProvider).reauthenticate(password);
    }
    final run = await ref.read(scenesProvider.notifier).run(scene, reauthToken: reauthToken);
    if (context.mounted) await showSceneRunSheet(context, run.id);
  } catch (error) {
    messenger.showSnackBar(SnackBar(content: Text(AppErrorMapper.mapError(error))));
  }
}

/// Asks, then deletes [scene]; its history stays.
Future<void> deleteScene(BuildContext context, WidgetRef ref, Scene scene) async {
  final confirmed = await confirmAction(
    context,
    title: 'Xóa kịch bản',
    message: 'Xóa "${scene.name}"? Lịch sử các lần đã chạy vẫn được giữ lại.',
    confirmLabel: 'Xóa',
    destructive: true,
  );
  if (!confirmed || !context.mounted) return;
  final messenger = ScaffoldMessenger.of(context);
  try {
    await ref.read(scenesProvider.notifier).delete(scene.id);
    messenger.showSnackBar(SnackBar(content: Text('Đã xóa "${scene.name}"')));
  } catch (error) {
    messenger.showSnackBar(SnackBar(content: Text(AppErrorMapper.mapError(error))));
  }
}
