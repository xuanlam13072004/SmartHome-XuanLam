// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'realtime_provider.dart';

// **************************************************************************
// RiverpodGenerator
// **************************************************************************

String _$webSocketClientHash() => r'44da7010fbc464ef1bf7ebe53b9668ce6676c213';

/// See also [webSocketClient].
@ProviderFor(webSocketClient)
final webSocketClientProvider = Provider<WebSocketClient>.internal(
  webSocketClient,
  name: r'webSocketClientProvider',
  debugGetCreateSourceHash: const bool.fromEnvironment('dart.vm.product')
      ? null
      : _$webSocketClientHash,
  dependencies: null,
  allTransitiveDependencies: null,
);

@Deprecated('Will be removed in 3.0. Use Ref instead')
// ignore: unused_element
typedef WebSocketClientRef = ProviderRef<WebSocketClient>;
String _$webSocketLifecycleHash() =>
    r'88972e30e899a5175793fc892213d5e3734c5c0b';

/// Listens to auth state changes and connects/disconnects WebSocket accordingly.
///
/// Copied from [webSocketLifecycle].
@ProviderFor(webSocketLifecycle)
final webSocketLifecycleProvider = Provider<void>.internal(
  webSocketLifecycle,
  name: r'webSocketLifecycleProvider',
  debugGetCreateSourceHash: const bool.fromEnvironment('dart.vm.product')
      ? null
      : _$webSocketLifecycleHash,
  dependencies: null,
  allTransitiveDependencies: null,
);

@Deprecated('Will be removed in 3.0. Use Ref instead')
// ignore: unused_element
typedef WebSocketLifecycleRef = ProviderRef<void>;
String _$realtimeRepositoryHash() =>
    r'6e506e2a0efcac0f52d99c4b00615d5910f84219';

/// See also [realtimeRepository].
@ProviderFor(realtimeRepository)
final realtimeRepositoryProvider = Provider<IRealtimeRepository>.internal(
  realtimeRepository,
  name: r'realtimeRepositoryProvider',
  debugGetCreateSourceHash: const bool.fromEnvironment('dart.vm.product')
      ? null
      : _$realtimeRepositoryHash,
  dependencies: null,
  allTransitiveDependencies: null,
);

@Deprecated('Will be removed in 3.0. Use Ref instead')
// ignore: unused_element
typedef RealtimeRepositoryRef = ProviderRef<IRealtimeRepository>;
String _$connectionStatusHash() => r'aa08a1f1d3f3be64463c79deba95e9337c46d3a2';

/// See also [connectionStatus].
@ProviderFor(connectionStatus)
final connectionStatusProvider =
    AutoDisposeStreamProvider<ConnectionStatus>.internal(
  connectionStatus,
  name: r'connectionStatusProvider',
  debugGetCreateSourceHash: const bool.fromEnvironment('dart.vm.product')
      ? null
      : _$connectionStatusHash,
  dependencies: null,
  allTransitiveDependencies: null,
);

@Deprecated('Will be removed in 3.0. Use Ref instead')
// ignore: unused_element
typedef ConnectionStatusRef = AutoDisposeStreamProviderRef<ConnectionStatus>;
// ignore_for_file: type=lint
// ignore_for_file: subtype_of_sealed_class, invalid_use_of_internal_member, invalid_use_of_visible_for_testing_member, deprecated_member_use_from_same_package
