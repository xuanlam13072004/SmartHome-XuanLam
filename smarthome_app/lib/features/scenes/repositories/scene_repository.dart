import '../models/scene_mock.dart';

abstract class ISceneRepository {
  Future<List<SceneMock>> getScenes();
  Future<void> activateScene(String sceneId);
}

class MockSceneRepository implements ISceneRepository {
  List<SceneMock> _inMemoryScenes = List.from(SceneMock.staticScenes);

  @override
  Future<List<SceneMock>> getScenes() async {
    await Future<void>.delayed(const Duration(milliseconds: 500));
    return _inMemoryScenes;
  }

  @override
  Future<void> activateScene(String sceneId) async {
    await Future<void>.delayed(const Duration(milliseconds: 300));
    // Tắt các kịch bản đang chạy và bật kịch bản mới
    _inMemoryScenes = _inMemoryScenes.map((scene) {
      if (scene.id == sceneId) {
        return SceneMock(
          id: scene.id,
          name: scene.name,
          icon: scene.icon,
          description: scene.description,
          isActive: true, // bật kịch bản này
        );
      }
      return SceneMock(
        id: scene.id,
        name: scene.name,
        icon: scene.icon,
        description: scene.description,
        isActive: false, // tắt các kịch bản khác
      );
    }).toList();
  }
}
