import 'package:flutter/material.dart';
import '../../../core/core.dart';
import '../../../core/widgets/widgets.dart';
import '../models/scene_mock.dart';
import '../widgets/scene_card.dart';

class ScenesScreen extends StatelessWidget {
  const ScenesScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return PageScaffold(
      appBar: AppBar(
        title: const Text('Kịch bản'),
        centerTitle: false,
      ),
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
      child: ListView.separated(
        padding: const EdgeInsets.only(top: AppSpacing.md, bottom: 100),
        itemCount: SceneMock.staticScenes.length,
        separatorBuilder: (_, __) => const SizedBox(height: AppSpacing.md),
        itemBuilder: (context, index) {
          final scene = SceneMock.staticScenes[index];
          return SceneCard(
            scene: scene,
            onTap: () {},
          );
        },
      ),
    );
  }
}
