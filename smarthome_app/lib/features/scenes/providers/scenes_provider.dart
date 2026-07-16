import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';
import '../models/scene_mock.dart';
import '../repositories/scene_repository.dart';

part 'scenes_provider.g.dart';

@riverpod
ISceneRepository sceneRepository(Ref ref) {
  return MockSceneRepository();
}

@riverpod
class Scenes extends _$Scenes {
  @override
  FutureOr<List<SceneMock>> build() async {
    return ref.read(sceneRepositoryProvider).getScenes();
  }

  Future<void> activateScene(String sceneId) async {
    final previousState = state;
    
    // Optimistic Update UI
    if (state.value != null) {
      final scenes = state.value!.map((scene) {
        return SceneMock(
          id: scene.id,
          name: scene.name,
          icon: scene.icon,
          description: scene.description,
          isActive: scene.id == sceneId,
        );
      }).toList();
      state = AsyncData(scenes);
    }

    try {
      await ref.read(sceneRepositoryProvider).activateScene(sceneId);
    } catch (e) {
      state = previousState;
    }
  }
}
