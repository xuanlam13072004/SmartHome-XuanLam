import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons/lucide_icons.dart';

import '../../../core/core.dart';
import '../../../core/utils/app_error_mapper.dart';
import '../../../core/utils/time_format.dart';
import '../../../core/widgets/widgets.dart';
import '../../notifications/widgets/paged_list_view.dart';
import '../data/scene_models.dart';
import '../providers/scenes_providers.dart';
import '../scene_labels.dart';
import 'scene_run_sheet.dart';

/// "Lịch sử chạy": every run of the account's scenes, newest first.
class SceneRunsScreen extends ConsumerWidget {
  const SceneRunsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final runs = ref.watch(sceneRunsProvider);
    return PageScaffold(
      scrollable: false,
      appBar: AppBar(title: const Text('Lịch sử chạy')),
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
      child: runs.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, _) => EmptyState(
          icon: LucideIcons.alertTriangle,
          title: 'Không tải được lịch sử',
          description: AppErrorMapper.mapError(error),
          actionText: 'Thử lại',
          onActionTap: () => ref.invalidate(sceneRunsProvider),
        ),
        data: (list) => list.items.isEmpty
            ? const EmptyState(
                icon: Icons.history_rounded,
                title: 'Chưa có lần chạy nào',
                description: 'Mỗi lần chạy kịch bản sẽ được ghi lại ở đây kèm kết quả từng bước.',
              )
            : DayGroupedPagedList<SceneRun>(
                list: list,
                timeOf: (run) => run.startedAt,
                onLoadMore: () => ref.read(sceneRunsProvider.notifier).loadMore(),
                onRefresh: () async {
                  ref.invalidate(sceneRunsProvider);
                  try {
                    await ref.read(sceneRunsProvider.future);
                  } catch (_) {}
                },
                itemBuilder: (context, run) => _RunTile(run: run),
              ),
      ),
    );
  }
}

class _RunTile extends StatelessWidget {
  const _RunTile({required this.run});

  final SceneRun run;

  @override
  Widget build(BuildContext context) {
    final tone = runTone(context, run.status);
    final done = run.steps.where((step) => step.status == 'succeeded').length;
    return ListTile(
      leading: Icon(runIcon(run.status), color: tone),
      title: Text(run.sceneName, maxLines: 1, overflow: TextOverflow.ellipsis),
      subtitle: Text(
        '${TimeFormat.clock(run.startedAt)} · ${SceneLabels.trigger(run.trigger, automationName: run.automationName)} · '
        '${SceneLabels.runStatus(run.status)} ($done/${run.steps.length} bước)',
      ),
      onTap: () => showSceneRunSheet(context, run.id),
    );
  }
}
