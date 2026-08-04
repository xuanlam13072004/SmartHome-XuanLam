import '../../domain/models/device_model.dart';
import '../dashboard/models/capability_model.dart';

extension ProductCapabilityQuery on DeviceModel {
  CapabilityModel? capabilityMatching({
    Iterable<String> ids = const [],
    Iterable<String> capabilityIds = const [],
    Iterable<String> semanticRoles = const [],
    CapabilitySection? section,
  }) {
    final idSet = _normalise(ids);
    final capabilityIdSet = _normalise(capabilityIds);
    final roleSet = _normalise(semanticRoles);

    for (final capability in capabilities) {
      if (section != null && capability.section != section) continue;
      if (idSet.contains(capability.id.toLowerCase()) ||
          capabilityIdSet.contains(capability.capabilityId.toLowerCase()) ||
          roleSet.contains(capability.semanticRole.toLowerCase())) {
        return capability;
      }
    }
    return null;
  }

  List<CapabilityModel> capabilitiesWhereHints({
    Iterable<String> hints = const [],
    CapabilitySection? section,
  }) {
    final tokens = hints.map((value) => value.toLowerCase()).toList();
    return capabilities.where((capability) {
      if (section != null && capability.section != section) return false;
      final haystack = [
        capability.id,
        capability.capabilityId,
        capability.semanticRole,
        capability.instance,
      ].join(' ').toLowerCase();
      return tokens.any(haystack.contains);
    }).toList();
  }

  CapabilityModel? get primaryOnOff {
    CapabilityModel? fallback;
    for (final capability in capabilities) {
      if (capability.section != CapabilitySection.control ||
          capability.type != 'on_off') {
        continue;
      }
      fallback ??= capability;
      final hint = '${capability.semanticRole} ${capability.id} '
              '${capability.capabilityId}'
          .toLowerCase();
      if (hint.contains('power') ||
          hint.contains('switch') ||
          hint.contains('light')) {
        return capability;
      }
    }
    return fallback;
  }
}

Set<String> _normalise(Iterable<String> values) =>
    values.map((value) => value.toLowerCase()).toSet();

String productCapabilityValue(CapabilityModel? capability,
    {String fallback = 'Chưa có dữ liệu'}) {
  if (capability == null || capability.value == null) return fallback;
  final value = capability.value;
  final unit = capability.properties['unit']?.toString() ?? '';
  if (value is bool) return value ? 'Đang bật' : 'Đang tắt';
  if (value is double) return '${value.toStringAsFixed(1)}$unit';
  return '$value$unit';
}
