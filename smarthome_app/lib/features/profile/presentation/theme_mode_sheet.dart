import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons/lucide_icons.dart';

import '../../../core/core.dart';
import '../../../core/theme/theme_mode_controller.dart';

Future<void> showThemeModeSheet(BuildContext context) {
  return showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    builder: (_) => const ThemeModeSheet(),
  );
}

/// Sáng / Tối / Theo hệ thống. Saved on this device and applied at once.
class ThemeModeSheet extends ConsumerWidget {
  const ThemeModeSheet({super.key});

  static const _options = <(ThemeMode, IconData, String)>[
    (ThemeMode.light, LucideIcons.sun, 'Nền sáng, dễ nhìn ban ngày'),
    (ThemeMode.dark, LucideIcons.moon, 'Nền tối, dịu mắt khi trời tối'),
    (ThemeMode.system, LucideIcons.monitor, 'Tự đổi theo cài đặt của máy'),
  ];

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final current = ref.watch(themeModeProvider);
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.only(bottom: AppSpacing.md),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
              child: Text('Giao diện', style: context.textTheme.titleLarge),
            ),
            const SizedBox(height: AppSpacing.sm),
            for (final (mode, icon, description) in _options)
              ListTile(
                leading: Icon(icon),
                title: Text(mode.label),
                subtitle: Text(description),
                selected: mode == current,
                trailing: mode == current ? const Icon(LucideIcons.check) : null,
                onTap: () => ref.read(themeModeProvider.notifier).select(mode),
              ),
          ],
        ),
      ),
    );
  }
}
