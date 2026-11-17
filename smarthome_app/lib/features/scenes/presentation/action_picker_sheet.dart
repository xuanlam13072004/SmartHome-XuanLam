import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/core.dart';
import '../../../core/utils/app_error_mapper.dart';
import '../../rooms/providers/rooms_providers.dart';
import '../data/scene_models.dart';
import '../providers/scenes_providers.dart';
import '../widgets/action_input_sheet.dart';

/// Picks a device, then one of its actions and its inputs. Returns the new step.
Future<SceneStep?> pickSceneStep(BuildContext context) {
  return showModalBottomSheet<SceneStep>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    useRootNavigator: true,
    builder: (_) => const _ActionPickerSheet(),
  );
}

class _ActionPickerSheet extends ConsumerWidget {
  const _ActionPickerSheet();

  Future<void> _choose(BuildContext context, SceneActionDevice device, SceneAction action) async {
    final navigator = Navigator.of(context);
    var input = <String, dynamic>{};
    if (action.input.isNotEmpty) {
      final values = await showActionInputSheet(context, action, deviceName: device.name);
      if (values == null) return;
      input = values;
    }
    navigator.pop(SceneStep.fromAction(device, action, input));
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final actions = ref.watch(sceneActionsProvider);
    final rooms = ref.watch(roomsProvider).valueOrNull;
    return ConstrainedBox(
      constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.8),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(AppSpacing.lg, 0, AppSpacing.lg, AppSpacing.sm),
            child: Text('Thêm bước', style: context.textTheme.titleLarge),
          ),
          Flexible(
            child: actions.when(
              loading: () => const Padding(
                padding: EdgeInsets.all(AppSpacing.xl),
                child: Center(child: CircularProgressIndicator()),
              ),
              error: (error, _) => Padding(
                padding: const EdgeInsets.all(AppSpacing.lg),
                child: Text(AppErrorMapper.mapError(error)),
              ),
              data: (devices) {
                if (devices.isEmpty) {
                  return const Padding(
                    padding: EdgeInsets.all(AppSpacing.lg),
                    child: Text('Bạn chưa có thiết bị nào có thể điều khiển trong kịch bản.'),
                  );
                }
                // Grouped by this account's rooms, in the rooms' order; no room last.
                final order = {for (final room in rooms?.rooms ?? const []) room.id: room.position};
                final sorted = [...devices]..sort((a, b) {
                    final left = order[a.roomId] ?? 1 << 20;
                    final right = order[b.roomId] ?? 1 << 20;
                    return left != right ? left.compareTo(right) : a.name.compareTo(b.name);
                  });
                final children = <Widget>[];
                String? group;
                for (final device in sorted) {
                  final roomName = rooms?.byId(device.roomId)?.name ?? 'Chưa xếp phòng';
                  if (roomName != group) {
                    group = roomName;
                    children.add(Padding(
                      padding: const EdgeInsets.fromLTRB(AppSpacing.lg, AppSpacing.md, AppSpacing.lg, AppSpacing.xs),
                      child: Text(roomName, style: context.textTheme.labelLarge?.copyWith(
                        color: context.colorScheme.primary,
                        fontWeight: FontWeight.w700,
                      )),
                    ));
                  }
                  children.add(ExpansionTile(
                    title: Text(device.name),
                    subtitle: Text('${device.actions.length} thao tác'),
                    children: [
                      for (final action in device.actions)
                        ListTile(
                          contentPadding: const EdgeInsets.only(left: AppSpacing.xl, right: AppSpacing.lg),
                          title: Text(action.label),
                          subtitle: Text(action.protected
                              ? '${action.instanceLabel} · Cần mật khẩu khi chạy'
                              : action.instanceLabel),
                          trailing: action.protected ? const Icon(Icons.lock_outline_rounded, size: 18) : null,
                          onTap: () => _choose(context, device, action),
                        ),
                    ],
                  ));
                }
                return ListView(
                  shrinkWrap: true,
                  padding: const EdgeInsets.only(bottom: AppSpacing.lg),
                  children: children,
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}
