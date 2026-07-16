import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/core.dart';
import '../../../core/widgets/widgets.dart';
import '../providers/scenes_provider.dart';
import '../widgets/scene_card.dart';

class ScenesScreen extends ConsumerWidget {
  const ScenesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final scenesAsync = ref.watch(scenesProvider);

    return PageScaffold(
      appBar: AppBar(
        title: const Text('Kịch bản'),
        centerTitle: false,
      ),
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
      child: scenesAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (err, stack) => Center(child: Text('Lỗi: $err')),
        data: (scenes) => ListView.separated(
          padding: const EdgeInsets.only(top: AppSpacing.md, bottom: 100),
          itemCount: scenes.length,
          separatorBuilder: (_, __) => const SizedBox(height: AppSpacing.md),
          itemBuilder: (context, index) {
            final scene = scenes[index];
            return SceneCard(
              scene: scene,
              onTap: () {
                ref.read(scenesProvider.notifier).activateScene(scene.id);
              },
            );
          },
        ),
      ),
    );
  }
}

