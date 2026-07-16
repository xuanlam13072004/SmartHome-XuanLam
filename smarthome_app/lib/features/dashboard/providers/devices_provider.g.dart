// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'devices_provider.dart';

// **************************************************************************
// RiverpodGenerator
// **************************************************************************

String _$deviceRepositoryHash() => r'acb5a766325c6dd45afdaab341b4ee1f8fb855d4';

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
String _$devicesHash() => r'45bb84d4eb7b75ddf641c41c44925ba138c2a8de';

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
