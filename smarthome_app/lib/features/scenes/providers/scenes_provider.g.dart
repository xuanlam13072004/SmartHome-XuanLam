// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'scenes_provider.dart';

// **************************************************************************
// RiverpodGenerator
// **************************************************************************

String _$sceneRepositoryHash() => r'30d0f5d822a1a1be80bfb16ca4dd1e48612b8018';

/// See also [sceneRepository].
@ProviderFor(sceneRepository)
final sceneRepositoryProvider = AutoDisposeProvider<ISceneRepository>.internal(
  sceneRepository,
  name: r'sceneRepositoryProvider',
  debugGetCreateSourceHash: const bool.fromEnvironment('dart.vm.product')
      ? null
      : _$sceneRepositoryHash,
  dependencies: null,
  allTransitiveDependencies: null,
);

@Deprecated('Will be removed in 3.0. Use Ref instead')
// ignore: unused_element
typedef SceneRepositoryRef = AutoDisposeProviderRef<ISceneRepository>;
String _$scenesHash() => r'bf9f68e821ceadff5425135bcf627443ced72f4b';

/// See also [Scenes].
@ProviderFor(Scenes)
final scenesProvider =
    AutoDisposeAsyncNotifierProvider<Scenes, List<SceneMock>>.internal(
  Scenes.new,
  name: r'scenesProvider',
  debugGetCreateSourceHash:
      const bool.fromEnvironment('dart.vm.product') ? null : _$scenesHash,
  dependencies: null,
  allTransitiveDependencies: null,
);

typedef _$Scenes = AutoDisposeAsyncNotifier<List<SceneMock>>;
// ignore_for_file: type=lint
// ignore_for_file: subtype_of_sealed_class, invalid_use_of_internal_member, invalid_use_of_visible_for_testing_member, deprecated_member_use_from_same_package
