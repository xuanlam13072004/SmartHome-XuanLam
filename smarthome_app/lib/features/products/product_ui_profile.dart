/// Stable UI profile identifiers published by the Product Catalog.
abstract final class ProductUiProfile {
  static const generic = 'generic';
  static const entranceController = 'entrance_controller';
  static const roofController = 'roof_controller';
  static const hazardMonitor = 'hazard_monitor';
  static const irrigationManager = 'irrigation_manager';

  static const supportedVersion = 1;

  /// Keeps old catalog responses usable while `ui_profile` rolls out.
  static String resolve({
    required String explicitProfile,
    required String productId,
  }) {
    final profile = explicitProfile.trim().toLowerCase();
    if (profile.isNotEmpty && profile != generic) return profile;

    final id = productId.toLowerCase();
    if (_containsAny(id, const ['entrance', 'door'])) {
      return entranceController;
    }
    if (_containsAny(id, const ['roof', 'awning', 'cover'])) {
      return roofController;
    }
    if (_containsAny(id, const ['hazard', 'alarm', 'safety'])) {
      return hazardMonitor;
    }
    if (_containsAny(id, const ['irrigation', 'garden', 'watering'])) {
      return irrigationManager;
    }
    return generic;
  }

  static bool supportsVersion(int version) => version == supportedVersion;

  static bool _containsAny(String value, List<String> candidates) =>
      candidates.any(value.contains);
}
