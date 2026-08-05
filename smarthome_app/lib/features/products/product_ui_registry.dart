import 'package:flutter/material.dart';

import '../../domain/models/device_model.dart';
import '../../domain/models/product_model.dart';
import 'product_ui_profile.dart';
import 'widgets/product_detail_views.dart';
import 'widgets/product_mini_cards.dart';

/// Single dispatch point for Product-specific compositions.
/// Capability widgets remain catalog-driven and reusable inside each view.
class ProductUiRegistry {
  const ProductUiRegistry();

  Widget buildMiniCard(
    BuildContext context, {
    required DeviceModel device,
    required VoidCallback onTap,
    required ProductCapabilityChanged onCapabilityChanged,
  }) {
    final profile = _supportedProfile(device);
    return switch (profile) {
      ProductUiProfile.entranceController => EntranceProductMiniCard(
          device: device,
          onTap: onTap,
        ),
      ProductUiProfile.roofController => RoofProductMiniCard(
          device: device,
          onTap: onTap,
        ),
      ProductUiProfile.hazardMonitor => HazardProductMiniCard(
          device: device,
          onTap: onTap,
        ),
      ProductUiProfile.irrigationManager => IrrigationProductMiniCard(
          device: device,
          onTap: onTap,
        ),
      _ => GenericProductMiniCard(
          device: device,
          onTap: onTap,
          onCapabilityChanged: onCapabilityChanged,
        ),
    };
  }

  Widget buildDetail(
    BuildContext context, {
    required DeviceModel device,
    required ProductCapabilityChanged onCapabilityChanged,
    Future<void> Function(DeviceResourceDefinition resource)? onOpenResource,
    Future<void> Function(DeviceCredentialDefinition credential)?
        onReplaceCredential,
  }) {
    final profile = _supportedProfile(device);
    return switch (profile) {
      ProductUiProfile.entranceController => EntranceProductDetail(
          device: device,
          onCapabilityChanged: onCapabilityChanged,
          onOpenResource: onOpenResource,
          onReplaceCredential: onReplaceCredential,
        ),
      ProductUiProfile.roofController => RoofProductDetail(
          device: device,
          onCapabilityChanged: onCapabilityChanged,
        ),
      ProductUiProfile.hazardMonitor => HazardProductDetail(
          device: device,
          onCapabilityChanged: onCapabilityChanged,
        ),
      ProductUiProfile.irrigationManager => IrrigationProductDetail(
          device: device,
          onCapabilityChanged: onCapabilityChanged,
        ),
      _ => GenericProductDetail(
          device: device,
          onCapabilityChanged: onCapabilityChanged,
        ),
    };
  }

  String _supportedProfile(DeviceModel device) {
    if (!ProductUiProfile.supportsVersion(device.uiProfileVersion)) {
      return ProductUiProfile.generic;
    }
    return ProductUiProfile.resolve(
      explicitProfile: device.uiProfile,
      productId: device.productId,
    );
  }
}

const productUiRegistry = ProductUiRegistry();
