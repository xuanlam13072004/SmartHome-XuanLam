import 'package:flutter/material.dart';
import 'package:lucide_icons/lucide_icons.dart';

import '../../../core/core.dart';
import '../data/assistant_models.dart';
import '../providers/assistant_chat.dart';

/// A scene or automation the assistant drafted, under its message: what
/// starts it, the steps, and "Lưu" / "Thôi". Nothing exists until "Lưu";
/// once saved, "Mở" opens it in the Kịch bản editor.
class DraftCard extends StatelessWidget {
  const DraftCard({
    super.key,
    required this.draft,
    required this.state,
    required this.onSave,
    required this.onDismiss,
    required this.onOpen,
  });

  final AssistantDraft draft;
  final DraftState state;
  final VoidCallback onSave;
  final VoidCallback onDismiss;

  /// Null until saved.
  final VoidCallback? onOpen;

  @override
  Widget build(BuildContext context) {
    final scheme = context.colorScheme;
    final muted = context.textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant);
    Widget line(IconData icon, String text, {bool strong = false}) => Padding(
          padding: const EdgeInsets.only(top: AppSpacing.xs),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(icon, size: 16, color: scheme.primary),
              const SizedBox(width: AppSpacing.xs),
              Expanded(
                child: Text(text, style: strong ? context.textTheme.bodyMedium : context.textTheme.bodySmall),
              ),
            ],
          ),
        );
    return Container(
      margin: const EdgeInsets.only(top: AppSpacing.xs),
      padding: const EdgeInsets.all(AppSpacing.sm),
      decoration: BoxDecoration(
        color: scheme.surface,
        borderRadius: BorderRadius.circular(AppRadius.sm),
        border: Border.all(color: scheme.outlineVariant),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(draft.automation ? 'Tự động hóa' : 'Kịch bản chạy bằng tay', style: muted),
          Text(draft.name, style: context.textTheme.titleSmall),
          if (draft.trigger != null) line(LucideIcons.zap, draft.trigger!, strong: true),
          for (final condition in draft.conditions) line(LucideIcons.filter, condition),
          if (draft.window != null) line(LucideIcons.clock, draft.window!),
          for (final step in draft.steps)
            line(LucideIcons.chevronRight, step.delay == null ? step.label : '${step.label} · ${step.delay}'),
          if (draft.notify != null) line(LucideIcons.bell, 'Gửi thông báo: "${draft.notify}"'),
          const SizedBox(height: AppSpacing.sm),
          switch (state) {
            DraftState.open => Wrap(
                spacing: AppSpacing.xs,
                children: [
                  FilledButton.icon(
                    onPressed: onSave,
                    icon: const Icon(LucideIcons.check, size: 16),
                    label: Text(draft.automation ? 'Lưu và bật' : 'Lưu kịch bản'),
                  ),
                  TextButton(onPressed: onDismiss, child: const Text('Thôi')),
                ],
              ),
            DraftState.saving => Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2)),
                  const SizedBox(width: AppSpacing.sm),
                  Text('Đang lưu…', style: muted),
                ],
              ),
            DraftState.saved => Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(LucideIcons.checkCircle2, size: 16, color: context.neu.successColor),
                  const SizedBox(width: AppSpacing.xs),
                  Text('Đã lưu', style: muted),
                  if (onOpen != null) TextButton(onPressed: onOpen, child: const Text('Mở')),
                ],
              ),
            DraftState.dismissed => Text('Đã bỏ qua', style: muted),
          },
        ],
      ),
    );
  }
}
