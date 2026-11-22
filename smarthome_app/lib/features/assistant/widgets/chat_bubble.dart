import 'package:flutter/material.dart';
import 'package:lucide_icons/lucide_icons.dart';

import '../../../core/core.dart';
import '../data/assistant_models.dart';

/// One message of the conversation. Assistant messages list the commands of
/// the turn with their status, a confirm button for those waiting, and the
/// choices of a question back.
class ChatBubble extends StatelessWidget {
  const ChatBubble({
    super.key,
    required this.fromUser,
    required this.text,
    this.actions = const [],
    this.options = const [],
    this.error = false,
    this.spoken = false,
    this.working = false,
    this.onConfirm,
    this.onOption,
    this.footer,
  });

  final bool fromUser;
  final String text;
  final List<AssistantAction> actions;
  final List<String> options;
  final bool error;

  /// The user's message was spoken (shown with a microphone).
  final bool spoken;

  /// Waiting for the server (a spinner instead of text).
  final bool working;
  final void Function(AssistantAction action)? onConfirm;
  final void Function(String option)? onOption;
  final Widget? footer;

  @override
  Widget build(BuildContext context) {
    final scheme = context.colorScheme;
    final background = fromUser
        ? scheme.primary
        : error
            ? scheme.errorContainer
            : scheme.surfaceContainerHighest;
    final foreground = fromUser
        ? scheme.onPrimary
        : error
            ? scheme.onErrorContainer
            : scheme.onSurface;
    return Align(
      alignment: fromUser ? Alignment.centerRight : Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width * 0.82),
        child: Container(
          margin: const EdgeInsets.only(bottom: AppSpacing.sm),
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.smMd, vertical: AppSpacing.sm),
          decoration: BoxDecoration(
            color: background,
            borderRadius: BorderRadius.only(
              topLeft: const Radius.circular(AppRadius.md),
              topRight: const Radius.circular(AppRadius.md),
              bottomLeft: Radius.circular(fromUser ? AppRadius.md : AppRadius.xs),
              bottomRight: Radius.circular(fromUser ? AppRadius.xs : AppRadius.md),
            ),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              if (working)
                SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2, color: foreground),
                )
              else
                Row(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (spoken) ...[
                      Icon(LucideIcons.mic, size: 14, color: foreground.withValues(alpha: 0.8)),
                      const SizedBox(width: 4),
                    ],
                    Flexible(child: Text(text, style: TextStyle(color: foreground))),
                  ],
                ),
              for (final action in actions) _ActionRow(action: action, onConfirm: onConfirm),
              if (options.isNotEmpty) ...[
                const SizedBox(height: AppSpacing.sm),
                Wrap(
                  spacing: AppSpacing.xs,
                  runSpacing: AppSpacing.xs,
                  children: [
                    for (final option in options)
                      ActionChip(label: Text(option), onPressed: onOption == null ? null : () => onOption!(option)),
                  ],
                ),
              ],
              if (footer != null) ...[const SizedBox(height: AppSpacing.xs), footer!],
            ],
          ),
        ),
      ),
    );
  }
}

class _ActionRow extends StatelessWidget {
  const _ActionRow({required this.action, required this.onConfirm});

  final AssistantAction action;
  final void Function(AssistantAction action)? onConfirm;

  @override
  Widget build(BuildContext context) {
    final (icon, color) = switch (action.status) {
      'sent' => (LucideIcons.checkCircle2, context.neu.successColor),
      'pending' => (LucideIcons.hourglass, context.neu.warningColor),
      'refused' => (LucideIcons.lock, context.colorScheme.error),
      _ => (LucideIcons.xCircle, context.colorScheme.error),
    };
    final title = action.kind == 'scene' ? 'Kịch bản "${action.target}"' : '${action.label} · ${action.target}';
    return Padding(
      padding: const EdgeInsets.only(top: AppSpacing.sm),
      child: Row(
        children: [
          Icon(icon, size: 16, color: color),
          const SizedBox(width: AppSpacing.xs),
          Expanded(child: Text(title, style: context.textTheme.bodySmall)),
          if (action.pending && onConfirm != null)
            TextButton(
              onPressed: () => onConfirm!(action),
              child: Text(action.needsPassword ? 'Nhập mật khẩu' : 'Xác nhận'),
            ),
        ],
      ),
    );
  }
}
