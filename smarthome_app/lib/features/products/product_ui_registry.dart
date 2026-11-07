import 'package:flutter/material.dart';

import '../../domain/models/device_model.dart';
import '../../domain/models/product_model.dart';
import '../camera/widgets/security_camera_product.dart';
import 'product_ui_profile.dart';
import 'widgets/entrance_product_page.dart';
import 'widgets/hazard_product_page.dart';
import 'widgets/irrigation_product_page.dart';
import 'widgets/product_detail_views.dart';
import 'widgets/product_mini_cards.dart';
import 'widgets/roof_product_page.dart';

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
      ProductUiProfile.securityCamera => SecurityCameraMiniCard(
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

  /// [activitySection] is the device history, built by the caller (owner
  /// only); pages place it last.
  Widget buildDetail(
    BuildContext context, {
    required DeviceModel device,
    required ProductCapabilityChanged onCapabilityChanged,
    Future<void> Function(DeviceCredentialDefinition credential)?
        onReplaceCredential,
    Widget? activitySection,
  }) {
    final profile = _supportedProfile(device);
    return switch (profile) {
      ProductUiProfile.entranceController => EntranceProductDetail(
          device: device,
          onCapabilityChanged: onCapabilityChanged,
          onReplaceCredential: onReplaceCredential,
          activitySection: activitySection,
        ),
      ProductUiProfile.roofController => RoofProductDetail(
          device: device,
          onCapabilityChanged: onCapabilityChanged,
          activitySection: activitySection,
        ),
      ProductUiProfile.hazardMonitor => HazardProductDetail(
          device: device,
          onCapabilityChanged: onCapabilityChanged,
          activitySection: activitySection,
        ),
      ProductUiProfile.irrigationManager => IrrigationProductDetail(
          device: device,
          onCapabilityChanged: onCapabilityChanged,
          activitySection: activitySection,
        ),
      ProductUiProfile.securityCamera => SecurityCameraProductDetail(
          device: device,
        ),
      _ => GenericProductDetail(
          device: device,
          onCapabilityChanged: onCapabilityChanged,
        ),
    };
  }

  /// Whether the page for [device] shows a device history section.
  bool hasActivity(DeviceModel device) => const {
        ProductUiProfile.entranceController,
        ProductUiProfile.roofController,
        ProductUiProfile.hazardMonitor,
        ProductUiProfile.irrigationManager,
      }.contains(_supportedProfile(device));

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
