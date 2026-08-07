import 'package:flutter/material.dart';
import '../../../../core/core.dart';
import '../../../../core/widgets/widgets.dart';
import '../../models/capability_model.dart';

abstract final class CapabilityVisuals {
  static IconData iconFor(CapabilityModel capability) {
    final configured = _icons[capability.iconName];
    if (configured != null && capability.iconName != 'tune') {
      return configured;
    }

    final hint = '${capability.semanticRole} ${capability.id}'.toLowerCase();
    if (hint.contains('temperature') || hint.contains('thermostat')) {
      return Icons.thermostat_rounded;
    }
    if (hint.contains('humidity') ||
        hint.contains('water') ||
        hint.contains('rain')) {
      return Icons.water_drop_rounded;
    }
    if (hint.contains('light') || hint.contains('brightness')) {
      return Icons.lightbulb_rounded;
    }
    if (hint.contains('fan') || hint.contains('wind')) {
      return Icons.air_rounded;
    }
    if (hint.contains('lock') || hint.contains('security')) {
      return Icons.lock_rounded;
    }
    if (hint.contains('power') || hint.contains('switch')) {
      return Icons.power_settings_new_rounded;
    }
    if (hint.contains('rssi') || hint.contains('wifi')) {
      return Icons.wifi_rounded;
    }
    if (hint.contains('battery')) return Icons.battery_full_rounded;
    if (hint.contains('memory') || hint.contains('heap')) {
      return Icons.memory_rounded;
    }
    if (hint.contains('uptime') || hint.contains('latency')) {
      return Icons.timer_rounded;
    }

    return switch (capability.section) {
      CapabilitySection.control => Icons.tune_rounded,
      CapabilitySection.sensor => Icons.sensors_rounded,
      CapabilitySection.diagnostic => Icons.monitor_heart_rounded,
    };
  }

  static Color accentFor(BuildContext context, CapabilityModel capability) {
    final hint = '${capability.semanticRole} ${capability.id}'.toLowerCase();
    Color readable(Color color) => context.theme.brightness == Brightness.light
        ? color.darken(0.28)
        : color;
    if (hint.contains('light') ||
        hint.contains('sun') ||
        hint.contains('brightness')) {
      return readable(context.neu.categoryLight);
    }
    if (hint.contains('temperature') ||
        hint.contains('humidity') ||
        hint.contains('fan') ||
        hint.contains('wind')) {
      return readable(context.neu.categoryClimate);
    }
    if (hint.contains('lock') ||
        hint.contains('security') ||
        hint.contains('alarm') ||
        hint.contains('fire') ||
        hint.contains('smoke') ||
        hint.contains('gas')) {
      return readable(context.neu.categorySecurity);
    }
    if (hint.contains('power') ||
        hint.contains('switch') ||
        hint.contains('pump')) {
      return readable(context.neu.categoryOutlet);
    }
    if (capability.section != CapabilitySection.control) {
      return readable(context.neu.categorySensor);
    }
    return context.colorScheme.primary;
  }

  static String valueText(CapabilityModel capability) {
    final value = capability.value;
    final unit = capability.properties['unit']?.toString() ?? '';
    if (value == null) return '—';
    if (value is bool) return value ? 'Bật' : 'Tắt';

    final formatted = switch (value) {
      int number => number.toString(),
      double number when number == number.roundToDouble() =>
        number.toInt().toString(),
      double number => number.toStringAsFixed(1),
      _ => value.toString(),
    };
    if (unit.isEmpty) return formatted;
    final semanticUnit = switch (unit) {
      'normalized' => '$formatted/100',
      'percent' => '$formatted%',
      'celsius' => '$formatted°C',
      'dbm' => '$formatted dBm',
      'second' => _durationText(value),
      _ => null,
    };
    if (semanticUnit != null) return semanticUnit;
    const attachedUnits = {'%', '°C', '°F', 'dB', 'dBm'};
    return attachedUnits.contains(unit)
        ? '$formatted$unit'
        : '$formatted $unit';
  }

  static String _durationText(dynamic value) {
    final seconds = value is num ? value.round() : int.tryParse('$value');
    if (seconds == null) return '—';
    if (seconds < 60) return '$seconds giây';
    if (seconds % 60 == 0) return '${seconds ~/ 60} phút';
    return '${seconds ~/ 60} phút ${seconds % 60} giây';
  }

  static String optionLabel(String option) {
    const labels = {
      'on': 'Bật',
      'off': 'Tắt',
      'auto': 'Tự động',
      'manual': 'Thủ công',
      'locked': 'Đã khóa',
      'unlocked': 'Đã mở khóa',
      'open': 'Mở',
      'opening': 'Đang mở',
      'closed': 'Đóng',
      'closing': 'Đang đóng',
      'stopped': 'Dừng',
      'silent': 'Yên lặng',
    };
    return labels[option.toLowerCase()] ?? _humanise(option);
  }

  static IconData optionIcon(String option) {
    return switch (option.toLowerCase()) {
      'on' => Icons.power_settings_new_rounded,
      'off' => Icons.power_off_rounded,
      'auto' => Icons.auto_awesome_rounded,
      'manual' => Icons.touch_app_rounded,
      'locked' => Icons.lock_rounded,
      'unlocked' => Icons.lock_open_rounded,
      'open' || 'opening' => Icons.keyboard_arrow_up_rounded,
      'closed' || 'closing' => Icons.keyboard_arrow_down_rounded,
      'stopped' => Icons.stop_rounded,
      'silent' => Icons.volume_off_rounded,
      _ => Icons.circle_outlined,
    };
  }

  static String subtitleFor(CapabilityModel capability) {
    final instanceName = capability.instanceDisplayName.trim();
    if (instanceName.isNotEmpty && instanceName != capability.name) {
      return instanceName;
    }
    return switch (capability.section) {
      CapabilitySection.control => 'Điều khiển',
      CapabilitySection.sensor => 'Cập nhật theo thời gian thực',
      CapabilitySection.diagnostic => 'Chỉ đọc',
    };
  }

  static String _humanise(String value) {
    if (value.isEmpty) return value;
    final words = value.replaceAll('_', ' ').trim();
    if (words.isEmpty) return words;
    return '${words[0].toUpperCase()}${words.substring(1)}';
  }

  static const Map<String, IconData> _icons = {
    'lock': Icons.lock_rounded,
    'dialpad': Icons.dialpad_rounded,
    'face': Icons.face_rounded,
    'contactless': Icons.contactless_rounded,
    'fingerprint': Icons.fingerprint_rounded,
    'videocam': Icons.videocam_rounded,
    'notifications': Icons.notifications_rounded,
    'vibration': Icons.vibration_rounded,
    'monitor': Icons.monitor_rounded,
    'monitor_heart': Icons.monitor_heart_rounded,
    'volume_up': Icons.volume_up_rounded,
    'volume_mute': Icons.volume_mute_rounded,
    'curtains': Icons.curtains_rounded,
    'opacity': Icons.opacity_rounded,
    'sunny': Icons.sunny,
    'thermostat': Icons.thermostat_rounded,
    'water_drop': Icons.water_drop_rounded,
    'arrow_upward': Icons.arrow_upward_rounded,
    'arrow_downward': Icons.arrow_downward_rounded,
    'gas_meter': Icons.gas_meter_rounded,
    'local_fire_department': Icons.local_fire_department_rounded,
    'smoke_free': Icons.smoke_free_rounded,
    'wind_power': Icons.wind_power_rounded,
    'electric_bolt': Icons.electric_bolt_rounded,
    'grass': Icons.grass_rounded,
    'waves': Icons.waves_rounded,
    'water_damage': Icons.water_damage_rounded,
    'play_arrow': Icons.play_arrow_rounded,
    'lightbulb': Icons.lightbulb_rounded,
    'tune': Icons.tune_rounded,
  };
}

class CapabilityHeading extends StatelessWidget {
  const CapabilityHeading({
    super.key,
    required this.capability,
    this.trailing,
    this.subtitle,
  });

  final CapabilityModel capability;
  final Widget? trailing;
  final String? subtitle;

  @override
  Widget build(BuildContext context) {
    final accent = CapabilityVisuals.accentFor(context, capability);
    return Row(
      children: [
        NeuContainer(
          width: 48,
          height: 48,
          borderRadius: AppRadius.md,
          depth: NeuDepth.pressed,
          color: Color.alphaBlend(
            accent.withValues(alpha: 0.12),
            context.neu.surface,
          ),
          child: Icon(
            CapabilityVisuals.iconFor(capability),
            color: accent,
            size: 24,
          ),
        ),
        const SizedBox(width: AppSpacing.smMd),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                capability.name,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: context.textTheme.titleMedium,
              ),
              const SizedBox(height: AppSpacing.xs),
              Text(
                subtitle ?? CapabilityVisuals.subtitleFor(capability),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: context.textTheme.bodySmall,
              ),
            ],
          ),
        ),
        if (trailing != null) ...[
          const SizedBox(width: AppSpacing.sm),
          trailing!,
        ],
      ],
    );
  }
}
