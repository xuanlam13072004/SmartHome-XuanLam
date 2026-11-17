import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/core.dart';
import '../../../core/utils/app_error_mapper.dart';
import '../../../core/utils/time_format.dart';
import '../data/scene_models.dart';
import '../providers/scenes_providers.dart';
import '../scene_labels.dart';

/// Live progress (or the record) of one run, step by step.
Future<void> showSceneRunSheet(BuildContext context, String runId) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    useRootNavigator: true,
    builder: (_) => _SceneRunSheet(runId: runId),
  );
}

Color runTone(BuildContext context, String status) => switch (status) {
      'succeeded' => context.neu.deviceOnline,
      'partial' => context.neu.warningColor,
      'failed' => context.colorScheme.error,
      _ => context.colorScheme.primary,
    };

IconData runIcon(String status) => switch (status) {
      'succeeded' => Icons.check_circle_rounded,
      'partial' => Icons.error_outline_rounded,
      'failed' => Icons.cancel_rounded,
      _ => Icons.play_circle_rounded,
    };

class _SceneRunSheet extends ConsumerWidget {
  const _SceneRunSheet({required this.runId});

  final String runId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final run = ref.watch(sceneRunProvider(runId));
    return ConstrainedBox(
      constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.8),
      child: run.when(
        loading: () => const Padding(
          padding: EdgeInsets.all(AppSpacing.xl),
          child: Center(child: CircularProgressIndicator()),
        ),
        error: (error, _) => Padding(
          padding: const EdgeInsets.all(AppSpacing.lg),
          child: Text(AppErrorMapper.mapError(error)),
        ),
        data: (run) => _RunView(run: run),
      ),
    );
  }
}

class _RunView extends StatelessWidget {
  const _RunView({required this.run});

  final SceneRun run;

  @override
  Widget build(BuildContext context) {
    final tone = runTone(context, run.status);
    final done = run.steps.where((step) => step.status == 'succeeded').length;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
          child: Row(
            children: [
              run.running
                  ? SizedBox.square(dimension: 28, child: CircularProgressIndicator(strokeWidth: 3, color: tone))
                  : Icon(runIcon(run.status), color: tone, size: 32),
              const SizedBox(width: AppSpacing.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(run.sceneName, style: context.textTheme.titleLarge, maxLines: 1, overflow: TextOverflow.ellipsis),
                    Text(
                      '${SceneLabels.runStatus(run.status)} · $done/${run.steps.length} bước · '
                      '${SceneLabels.trigger(run.trigger, automationName: run.automationName)} lúc ${TimeFormat.clock(run.startedAt)}',
                      style: context.textTheme.bodySmall?.copyWith(color: tone, fontWeight: FontWeight.w600),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: AppSpacing.sm),
        Flexible(
          child: ListView(
            shrinkWrap: true,
            padding: const EdgeInsets.only(bottom: AppSpacing.lg),
            children: [for (final step in run.steps) _StepRow(step: step, running: run.running)],
          ),
        ),
      ],
    );
  }
}

class _StepRow extends StatelessWidget {
  const _StepRow({required this.step, required this.running});

  final SceneRunStep step;
  final bool running;

  @override
  Widget build(BuildContext context) {
    final scheme = context.colorScheme;
    final input = SceneLabels.input(step.input);
    final Widget leading = switch (step.status) {
      'succeeded' => Icon(Icons.check_circle_rounded, color: context.neu.deviceOnline),
      'failed' => Icon(Icons.cancel_rounded, color: scheme.error),
      'dispatched' => const SizedBox.square(dimension: 22, child: CircularProgressIndicator(strokeWidth: 2.5)),
      _ => Icon(Icons.schedule_rounded, color: scheme.onSurfaceVariant),
    };
    final detail = switch (step.status) {
      'failed' => SceneLabels.reason(step.reasonCode),
      'pending' when running && step.delaySeconds > 0 => SceneLabels.delay(step.delaySeconds),
      _ => SceneLabels.stepStatus(step.status),
    };
    return ListTile(
      leading: SizedBox(width: 28, child: Center(child: leading)),
      title: Text(step.deviceName, maxLines: 1, overflow: TextOverflow.ellipsis),
      subtitle: Text(
        '${input.isEmpty ? step.label : '${step.label} · $input'}\n$detail',
        style: step.status == 'failed' ? TextStyle(color: scheme.error) : null,
      ),
      isThreeLine: true,
    );
  }
}
