/// Stable UI profile identifiers published by the Product Catalog.
abstract final class ProductUiProfile {
  static const generic = 'generic';
  static const entranceController = 'entrance_controller';
  static const roofController = 'roof_controller';
  static const hazardMonitor = 'hazard_monitor';
  static const irrigationManager = 'irrigation_manager';

  static const supportedVersion = 1;

  static String resolve({
    required String explicitProfile,
    required String productId,
  }) {
    final profile = explicitProfile.trim().toLowerCase();
    return profile.isEmpty ? generic : profile;
  }

  static bool supportsVersion(int version) => version == supportedVersion;
}
