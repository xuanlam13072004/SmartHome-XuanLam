// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'devices_provider.dart';

// **************************************************************************
// RiverpodGenerator
// **************************************************************************

String _$deviceRepositoryHash() => r'4e00018f6095a27ec5c1f781e968ad6a42186e9f';

/// See also [deviceRepository].
@ProviderFor(deviceRepository)
final deviceRepositoryProvider = Provider<IDeviceRepository>.internal(
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
typedef DeviceRepositoryRef = ProviderRef<IDeviceRepository>;
String _$devicesHash() => r'b6ec619636e4a68bc77b143c4f9853adeacc67db';

/// See also [Devices].
@ProviderFor(Devices)
final devicesProvider =
    AutoDisposeAsyncNotifierProvider<Devices, List<DeviceModel>>.internal(
  Devices.new,
  name: r'devicesProvider',
  debugGetCreateSourceHash:
      const bool.fromEnvironment('dart.vm.product') ? null : _$devicesHash,
  dependencies: null,
  allTransitiveDependencies: null,
);

typedef _$Devices = AutoDisposeAsyncNotifier<List<DeviceModel>>;
// ignore_for_file: type=lint
// ignore_for_file: subtype_of_sealed_class, invalid_use_of_internal_member, invalid_use_of_visible_for_testing_member, deprecated_member_use_from_same_package
