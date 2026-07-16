// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'devices_provider.dart';

// **************************************************************************
// RiverpodGenerator
// **************************************************************************

String _$deviceRepositoryHash() => r'840cc953b29bb0ec90d64010ceb0df97dc54ead0';

/// See also [deviceRepository].
@ProviderFor(deviceRepository)
final deviceRepositoryProvider =
    AutoDisposeProvider<IDeviceRepository>.internal(
  deviceRepository,
  name: r'deviceRepositoryProvider',
  debugGetCreateSourceHash: const bool.fromEnvironment('dart.vm.product')
      ? null
      : _$deviceRepositoryHash,
  dependencies: null,
  allTransitiveDependencies: null,
);

@Deprecated('Will be removed in 3.0. Use Ref instead')
// ignore: unused_element
typedef DeviceRepositoryRef = AutoDisposeProviderRef<IDeviceRepository>;
String _$devicesHash() => r'8ef1cab717f49af709282ac9e785fbe7aa85965f';

/// See also [Devices].
@ProviderFor(Devices)
final devicesProvider =
    AutoDisposeAsyncNotifierProvider<Devices, List<DeviceMock>>.internal(
  Devices.new,
  name: r'devicesProvider',
  debugGetCreateSourceHash:
      const bool.fromEnvironment('dart.vm.product') ? null : _$devicesHash,
  dependencies: null,
  allTransitiveDependencies: null,
);

typedef _$Devices = AutoDisposeAsyncNotifier<List<DeviceMock>>;
// ignore_for_file: type=lint
// ignore_for_file: subtype_of_sealed_class, invalid_use_of_internal_member, invalid_use_of_visible_for_testing_member, deprecated_member_use_from_same_package
