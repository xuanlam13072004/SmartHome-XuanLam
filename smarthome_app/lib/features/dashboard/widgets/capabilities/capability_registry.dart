import 'package:flutter/material.dart';
import '../../models/capability_model.dart';
import 'capability_toggle_widget.dart';
import 'capability_slider_widget.dart';
import 'capability_sensor_widget.dart';
import 'capability_mode_widget.dart';
import 'capability_generic_widget.dart';

typedef CapabilityWidgetBuilder = Widget Function(
  BuildContext context,
  CapabilityModel capability,
  ValueChanged<dynamic> onChanged,
);

class CapabilityRegistry {
  // Singleton
  static final CapabilityRegistry _instance = CapabilityRegistry._internal();
  factory CapabilityRegistry() => _instance;
  CapabilityRegistry._internal();

  final Map<String, CapabilityWidgetBuilder> _registry = {};

  void register(String type, CapabilityWidgetBuilder builder) {
    _registry[type] = builder;
  }

  // Khởi tạo các capability mặc định
  void initDefaultCapabilities() {
    register('on_off', (context, capability, onChanged) {
      return CapabilityToggleWidget(
        capability: capability,
        onChanged: (val) => onChanged(val),
      );
    });

    register('range', (context, capability, onChanged) {
      return CapabilitySliderWidget(
        capability: capability,
        onChanged: (val) => onChanged(val),
      );
    });

    register('sensor', (context, capability, onChanged) {
      return CapabilitySensorWidget(
        capability: capability,
      );
    });

    register('enum', (context, capability, onChanged) {
      return CapabilityModeWidget(
        capability: capability,
        onChanged: (val) => onChanged(val),
      );
    });
  }

  Widget buildWidget(BuildContext context, CapabilityModel capability, ValueChanged<dynamic> onChanged) {
    final builder = _registry[capability.type];
    if (builder != null) {
      return builder(context, capability, onChanged);
    }
    // Generic fallback for unknown capability types — shows name + current value
    return CapabilityGenericWidget(
      capability: capability,
    );
  }

  List<Widget> buildWidgets(BuildContext context, List<CapabilityModel> capabilities, void Function(String id, dynamic value) onCapabilityChanged) {
    return capabilities.map((cap) {
      return Padding(
        padding: const EdgeInsets.only(bottom: 16.0),
        child: buildWidget(
          context,
          cap,
          (val) => onCapabilityChanged(cap.id, val),
        ),
      );
    }).toList();
  }
}

// Global instance
final capabilityRegistry = CapabilityRegistry()..initDefaultCapabilities();
