import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons/lucide_icons.dart';

import '../../../core/core.dart';
import '../../../core/navigation/app_routes.dart';
import '../../../core/utils/app_error_mapper.dart';
import '../../../core/widgets/widgets.dart';
import '../../scenes/data/scene_models.dart';
import '../../scenes/providers/scenes_providers.dart';
import '../automation_labels.dart';
import '../data/automation_models.dart';
import '../providers/automations_providers.dart';
import '../widgets/automation_card.dart';

/// "Tự động": suggestions for the account's devices, then its automations.
class AutomationsTab extends ConsumerStatefulWidget {
  const AutomationsTab({super.key});

  @override
  ConsumerState<AutomationsTab> createState() => _AutomationsTabState();
}

class _AutomationsTabState extends ConsumerState<AutomationsTab> {
  final Set<String> _busy = {};

  Future<void> _guard(String key, Future<void> Function() work, {String? done}) async {
    setState(() => _busy.add(key));
    final messenger = ScaffoldMessenger.of(context);
    try {
      await work();
      if (done != null) messenger.showSnackBar(SnackBar(content: Text(done)));
    } catch (error) {
      messenger.showSnackBar(SnackBar(content: Text(AppErrorMapper.mapError(error))));
    } finally {
      if (mounted) setState(() => _busy.remove(key));
    }
  }

  Future<void> _refresh() async {
    ref.invalidate(automationsProvider);
    ref.invalidate(automationSuggestionsProvider);
    try {
      await ref.read(automationsProvider.future);
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    final automations = ref.watch(automationsProvider);
    final suggestions = ref.watch(automationSuggestionsProvider).valueOrNull ?? const <AutomationSuggestion>[];
    // Scene names as they are now (renamed or deleted since the list was loaded).
    final scenes = <String, String>{
      for (final scene in ref.watch(scenesProvider).valueOrNull?.scenes ?? const <Scene>[]) scene.id: scene.name,
    };
    final controller = ref.read(automationsProvider.notifier);

    return automations.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (error, _) => EmptyState(
        icon: LucideIcons.alertTriangle,
        title: 'Không tải được tự động hóa',
        description: AppErrorMapper.mapError(error),
        actionText: 'Thử lại',
        onActionTap: _refresh,
      ),
      data: (list) => RefreshIndicator(
        onRefresh: _refresh,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.only(top: AppSpacing.sm, bottom: 120),
          children: [
            if (suggestions.isNotEmpty) ...[
              Text('Gợi ý cho bạn', style: context.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
              const SizedBox(height: AppSpacing.sm),
              for (final suggestion in suggestions)
                Padding(
                  padding: const EdgeInsets.only(bottom: AppSpacing.sm),
                  child: _SuggestionCard(
                    suggestion: suggestion,
                    busy: _busy.contains(suggestion.key),
                    onAdd: list.isFull
                        ? null
                        : () => _guard(
                              suggestion.key,
                              () => controller.applySuggestion(suggestion),
                              done: 'Đã thêm "${suggestion.title}"',
                            ),
                  ),
                ),
              const SizedBox(height: AppSpacing.md),
            ],
            if (list.automations.isEmpty)
              EmptyState(
                icon: Icons.auto_mode_rounded,
                title: 'Chưa có tự động hóa',
                description: 'Để nhà tự phản ứng: khi cửa mở lúc đêm thì báo cho bạn, '
                    'khi trời mưa thì dừng tưới, 23:00 cửa chưa khóa thì tự khóa.',
                actionText: 'Tạo tự động hóa',
                onActionTap: () => context.push(AppRoutes.automationNew),
              )
            else ...[
              Text(
                'Tự động hóa của bạn (${list.automations.length}/${list.maxAutomations})',
                style: context.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800),
              ),
              const SizedBox(height: AppSpacing.sm),
              for (final automation in list.automations)
                Padding(
                  padding: const EdgeInsets.only(bottom: AppSpacing.md),
                  child: AutomationCard(
                    automation: automation,
                    sceneName: scenes[automation.sceneId],
                    busy: _busy.contains(automation.id),
                    onOpen: () => context.push(AppRoutes.automationEditOf(automation.id)),
                    onToggle: (on) => _guard(automation.id, () => controller.setEnabled(automation, on)),
                  ),
                ),
            ],
          ],
        ),
      ),
    );
  }
}

class _SuggestionCard extends StatelessWidget {
  const _SuggestionCard({required this.suggestion, required this.busy, required this.onAdd});

  final AutomationSuggestion suggestion;
  final bool busy;
  final VoidCallback? onAdd;

  @override
  Widget build(BuildContext context) {
    final scheme = context.colorScheme;
    return NeuCard(
      padding: const EdgeInsets.all(AppSpacing.md),
      child: Row(
        children: [
          Icon(AutomationLabels.suggestionIcon(suggestion.template), color: scheme.primary),
          const SizedBox(width: AppSpacing.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(suggestion.title, style: context.textTheme.bodyLarge?.copyWith(fontWeight: FontWeight.w700)),
                const SizedBox(height: 2),
                Text(
                  suggestion.description,
                  style: context.textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant),
                ),
              ],
            ),
          ),
          const SizedBox(width: AppSpacing.sm),
          busy
              ? const SizedBox.square(dimension: 24, child: CircularProgressIndicator(strokeWidth: 2.5))
              : FilledButton.tonal(onPressed: onAdd, child: const Text('Thêm')),
        ],
      ),
    );
  }
}
