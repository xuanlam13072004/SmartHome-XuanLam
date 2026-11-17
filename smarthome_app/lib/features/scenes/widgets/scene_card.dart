import 'package:flutter/material.dart';

import '../../../core/core.dart';
import '../../../core/utils/time_format.dart';
import '../../../core/widgets/widgets.dart';
import '../data/scene_models.dart';
import '../presentation/scene_run_sheet.dart' show runTone;
import '../scene_icons.dart';
import '../scene_labels.dart';

/// A scene on "Kịch bản": what it does at a glance, its last run, and Run.
class SceneCard extends StatelessWidget {
  const SceneCard({
    super.key,
    required this.scene,
    required this.onRun,
    required this.onOpen,
    required this.menu,
  });

  final Scene scene;
  final VoidCallback onRun;
  final VoidCallback onOpen;
  final Widget menu;

  @override
  Widget build(BuildContext context) {
    final scheme = context.colorScheme;
    final running = scene.lastRunStatus == 'running';
    final nextRun = scene.nextScheduledRun;
    final devices = scene.steps.map((step) => step.deviceName).toSet().toList();
    final summary = scene.steps.isEmpty
        ? 'Chưa có bước nào'
        : '${scene.steps.length} bước · ${devices.take(2).join(', ')}${devices.length > 2 ? '…' : ''}';
    return Semantics(
      button: true,
      label: '${scene.name}, $summary',
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onOpen,
        child: NeuCard(
          padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.md, AppSpacing.xs, AppSpacing.md),
          child: Row(
            children: [
              NeuIconBox(icon: sceneIcon(scene.icon), size: 48, iconSize: 24, isActive: running),
              const SizedBox(width: AppSpacing.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      scene.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: context.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      summary,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: context.textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant),
                    ),
                    if (nextRun != null) ...[
                      const SizedBox(height: 2),
                      Row(
                        children: [
                          Icon(Icons.schedule_rounded, size: 13, color: scheme.primary),
                          const SizedBox(width: 4),
                          Flexible(
                            child: Text(
                              'Lần tới ${SceneLabels.nextRun(nextRun)}',
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: context.textTheme.labelSmall?.copyWith(
                                color: scheme.primary,
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ],
                    const SizedBox(height: 2),
                    if (scene.hasUnavailableSteps)
                      Text(
                        'Có bước không còn dùng được',
                        style: context.textTheme.labelSmall?.copyWith(color: scheme.error, fontWeight: FontWeight.w700),
                      )
                    else if (scene.lastRunStatus != null && scene.lastRunAt != null)
                      Text(
                        '${SceneLabels.runStatus(scene.lastRunStatus!)} · ${TimeFormat.relative(scene.lastRunAt!)}',
                        style: context.textTheme.labelSmall?.copyWith(
                          color: runTone(context, scene.lastRunStatus!),
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                  ],
                ),
              ),
              Tooltip(
                message: running ? 'Xem tiến trình' : 'Chạy',
                child: IconButton.filledTonal(
                  onPressed: onRun,
                  icon: running
                      ? const SizedBox.square(dimension: 20, child: CircularProgressIndicator(strokeWidth: 2.5))
                      : Icon(scene.protected ? Icons.lock_open_rounded : Icons.play_arrow_rounded),
                ),
              ),
              menu,
            ],
          ),
        ),
      ),
    );
  }
}
