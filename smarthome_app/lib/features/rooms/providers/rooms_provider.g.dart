// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'rooms_provider.dart';

// **************************************************************************
// RiverpodGenerator
// **************************************************************************

String _$roomRepositoryHash() => r'acea911df29dc734e3c2263f75e1220ad6cc051f';

/// See also [roomRepository].
@ProviderFor(roomRepository)
final roomRepositoryProvider = AutoDisposeProvider<IRoomRepository>.internal(
  roomRepository,
  name: r'roomRepositoryProvider',
  debugGetCreateSourceHash: const bool.fromEnvironment('dart.vm.product')
      ? null
      : _$roomRepositoryHash,
  dependencies: null,
  allTransitiveDependencies: null,
);

@Deprecated('Will be removed in 3.0. Use Ref instead')
// ignore: unused_element
typedef RoomRepositoryRef = AutoDisposeProviderRef<IRoomRepository>;
String _$roomsHash() => r'202911feb11b6f554fe5e38787df37873cba1441';

/// See also [Rooms].
@ProviderFor(Rooms)
final roomsProvider =
    AutoDisposeAsyncNotifierProvider<Rooms, List<RoomMock>>.internal(
  Rooms.new,
  name: r'roomsProvider',
  debugGetCreateSourceHash:
      const bool.fromEnvironment('dart.vm.product') ? null : _$roomsHash,
  dependencies: null,
  allTransitiveDependencies: null,
);

typedef _$Rooms = AutoDisposeAsyncNotifier<List<RoomMock>>;
// ignore_for_file: type=lint
// ignore_for_file: subtype_of_sealed_class, invalid_use_of_internal_member, invalid_use_of_visible_for_testing_member, deprecated_member_use_from_same_package
