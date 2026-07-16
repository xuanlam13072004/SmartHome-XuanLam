// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'rooms_provider.dart';

// **************************************************************************
// RiverpodGenerator
// **************************************************************************

String _$roomRepositoryHash() => r'706ceaa2665fede80a945076b2cf5d5c99be7056';

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
String _$activeDevicesInRoomHash() =>
    r'131aaa5a047240a764f1a9455ac3a1ec3847de02';

/// Copied from Dart SDK
class _SystemHash {
  _SystemHash._();

  static int combine(int hash, int value) {
    // ignore: parameter_assignments
    hash = 0x1fffffff & (hash + value);
    // ignore: parameter_assignments
    hash = 0x1fffffff & (hash + ((0x0007ffff & hash) << 10));
    return hash ^ (hash >> 6);
  }

  static int finish(int hash) {
    // ignore: parameter_assignments
    hash = 0x1fffffff & (hash + ((0x03ffffff & hash) << 3));
    // ignore: parameter_assignments
    hash = hash ^ (hash >> 11);
    return 0x1fffffff & (hash + ((0x00003fff & hash) << 15));
  }
}

/// Tính số lượng thiết bị đang bật trong 1 phòng, dựa vào devicesProvider.
/// Khi Devices thay đổi trạng thái, Provider này sẽ tự tính toán lại.
///
/// Copied from [activeDevicesInRoom].
@ProviderFor(activeDevicesInRoom)
const activeDevicesInRoomProvider = ActiveDevicesInRoomFamily();

/// Tính số lượng thiết bị đang bật trong 1 phòng, dựa vào devicesProvider.
/// Khi Devices thay đổi trạng thái, Provider này sẽ tự tính toán lại.
///
/// Copied from [activeDevicesInRoom].
class ActiveDevicesInRoomFamily extends Family<int> {
  /// Tính số lượng thiết bị đang bật trong 1 phòng, dựa vào devicesProvider.
  /// Khi Devices thay đổi trạng thái, Provider này sẽ tự tính toán lại.
  ///
  /// Copied from [activeDevicesInRoom].
  const ActiveDevicesInRoomFamily();

  /// Tính số lượng thiết bị đang bật trong 1 phòng, dựa vào devicesProvider.
  /// Khi Devices thay đổi trạng thái, Provider này sẽ tự tính toán lại.
  ///
  /// Copied from [activeDevicesInRoom].
  ActiveDevicesInRoomProvider call(
    String roomName,
  ) {
    return ActiveDevicesInRoomProvider(
      roomName,
    );
  }

  @override
  ActiveDevicesInRoomProvider getProviderOverride(
    covariant ActiveDevicesInRoomProvider provider,
  ) {
    return call(
      provider.roomName,
    );
  }

  static const Iterable<ProviderOrFamily>? _dependencies = null;

  @override
  Iterable<ProviderOrFamily>? get dependencies => _dependencies;

  static const Iterable<ProviderOrFamily>? _allTransitiveDependencies = null;

  @override
  Iterable<ProviderOrFamily>? get allTransitiveDependencies =>
      _allTransitiveDependencies;

  @override
  String? get name => r'activeDevicesInRoomProvider';
}

/// Tính số lượng thiết bị đang bật trong 1 phòng, dựa vào devicesProvider.
/// Khi Devices thay đổi trạng thái, Provider này sẽ tự tính toán lại.
///
/// Copied from [activeDevicesInRoom].
class ActiveDevicesInRoomProvider extends AutoDisposeProvider<int> {
  /// Tính số lượng thiết bị đang bật trong 1 phòng, dựa vào devicesProvider.
  /// Khi Devices thay đổi trạng thái, Provider này sẽ tự tính toán lại.
  ///
  /// Copied from [activeDevicesInRoom].
  ActiveDevicesInRoomProvider(
    String roomName,
  ) : this._internal(
          (ref) => activeDevicesInRoom(
            ref as ActiveDevicesInRoomRef,
            roomName,
          ),
          from: activeDevicesInRoomProvider,
          name: r'activeDevicesInRoomProvider',
          debugGetCreateSourceHash:
              const bool.fromEnvironment('dart.vm.product')
                  ? null
                  : _$activeDevicesInRoomHash,
          dependencies: ActiveDevicesInRoomFamily._dependencies,
          allTransitiveDependencies:
              ActiveDevicesInRoomFamily._allTransitiveDependencies,
          roomName: roomName,
        );

  ActiveDevicesInRoomProvider._internal(
    super._createNotifier, {
    required super.name,
    required super.dependencies,
    required super.allTransitiveDependencies,
    required super.debugGetCreateSourceHash,
    required super.from,
    required this.roomName,
  }) : super.internal();

  final String roomName;

  @override
  Override overrideWith(
    int Function(ActiveDevicesInRoomRef provider) create,
  ) {
    return ProviderOverride(
      origin: this,
      override: ActiveDevicesInRoomProvider._internal(
        (ref) => create(ref as ActiveDevicesInRoomRef),
        from: from,
        name: null,
        dependencies: null,
        allTransitiveDependencies: null,
        debugGetCreateSourceHash: null,
        roomName: roomName,
      ),
    );
  }

  @override
  AutoDisposeProviderElement<int> createElement() {
    return _ActiveDevicesInRoomProviderElement(this);
  }

  @override
  bool operator ==(Object other) {
    return other is ActiveDevicesInRoomProvider && other.roomName == roomName;
  }

  @override
  int get hashCode {
    var hash = _SystemHash.combine(0, runtimeType.hashCode);
    hash = _SystemHash.combine(hash, roomName.hashCode);

    return _SystemHash.finish(hash);
  }
}

@Deprecated('Will be removed in 3.0. Use Ref instead')
// ignore: unused_element
mixin ActiveDevicesInRoomRef on AutoDisposeProviderRef<int> {
  /// The parameter `roomName` of this provider.
  String get roomName;
}

class _ActiveDevicesInRoomProviderElement
    extends AutoDisposeProviderElement<int> with ActiveDevicesInRoomRef {
  _ActiveDevicesInRoomProviderElement(super.provider);

  @override
  String get roomName => (origin as ActiveDevicesInRoomProvider).roomName;
}

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
