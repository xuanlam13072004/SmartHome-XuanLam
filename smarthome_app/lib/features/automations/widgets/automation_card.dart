import 'package:flutter/material.dart';

import '../../../core/core.dart';
import '../../../core/widgets/widgets.dart';
import '../../scenes/scene_labels.dart';
import '../automation_labels.dart';
import '../data/automation_models.dart';

/// An automation on "Tự động": Khi → Thì at a glance, its last result and an on/off switch.
class AutomationCard extends StatelessWidget {
  const AutomationCard({
    super.key,
    required this.automation,
    required this.sceneName,
    required this.busy,
    required this.onOpen,
    required this.onToggle,
  });

  final Automation automation;

  /// The scene it runs, as currently named; null when it runs none or the scene is gone.
  final String? sceneName;
  final bool busy;
  final VoidCallback onOpen;
  final ValueChanged<bool> onToggle;

  @override
  Widget build(BuildContext context) {
    final scheme = context.colorScheme;
    final muted = scheme.onSurfaceVariant;
    final sceneGone = automation.sceneId != null && sceneName == null;
    final actions = [
      if (sceneName != null) 'Chạy “$sceneName”',
      if (automation.notifyMessage != null) 'Gửi thông báo',
    ];
    final last = AutomationLabels.lastResult(
      automation.lastResult,
      automation.lastTriggeredAt,
      skipReason: automation.lastSkipReason,
    );
    final next = automation.enabled && automation.nextRunAt != null
        ? 'Lần tới ${SceneLabels.nextRun(automation.nextRunAt!)}'
        : null;
    final problem = automation.hasUnavailableParts
        ? 'Có thiết bị không còn dùng được'
        : sceneGone && actions.isEmpty
            ? 'Kịch bản đã bị xóa, hãy chọn việc cần làm'
            : null;

    return Semantics(
      button: true,
      label: '${automation.name}, ${automation.enabled ? 'đang bật' : 'đang tắt'}',
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onOpen,
        child: NeuCard(
          padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.md, AppSpacing.sm, AppSpacing.md),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              NeuIconBox(
                icon: AutomationLabels.triggerIcon(automation.trigger.kind),
                size: 48,
                iconSize: 24,
                isActive: automation.enabled,
              ),
              const SizedBox(width: AppSpacing.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      automation.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: context.textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.w700,
                        color: automation.enabled ? null : muted,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      'Khi ${AutomationLabels.trigger(automation.trigger)}',
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: context.textTheme.bodySmall?.copyWith(color: muted),
                    ),
                    if (actions.isNotEmpty)
                      Text(
                        '→ ${actions.join(' · ')}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: context.textTheme.bodySmall?.copyWith(color: muted),
                      ),
                    if (problem != null)
                      Text(
                        problem,
                        style: context.textTheme.labelSmall?.copyWith(color: scheme.error, fontWeight: FontWeight.w700),
                      )
                    else if (next != null || last != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 2),
                        child: Text(
                          next ?? last!,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: context.textTheme.labelSmall?.copyWith(
                            color: next != null ? scheme.primary : muted,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                      ),
                  ],
                ),
              ),
              busy
                  ? const Padding(
                      padding: EdgeInsets.all(AppSpacing.sm),
                      child: SizedBox.square(dimension: 24, child: CircularProgressIndicator(strokeWidth: 2.5)),
                    )
                  : Switch(value: automation.enabled, onChanged: onToggle),
            ],
          ),
        ),
      ),
    );
  }
}
