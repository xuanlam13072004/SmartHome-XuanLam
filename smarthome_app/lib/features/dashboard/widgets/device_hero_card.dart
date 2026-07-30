import 'package:flutter/material.dart';
import '../../../core/core.dart';
import '../../../core/widgets/widgets.dart';
import '../../../domain/models/device_model.dart';
import '../models/capability_model.dart';
import 'capabilities/capability_visuals.dart';
import 'topology_badge.dart';

class DeviceHeroCard extends StatelessWidget {
  const DeviceHeroCard({
    super.key,
    required this.device,
    this.primaryPower,
    this.onPowerChanged,
  });

  final DeviceModel device;
  final CapabilityModel? primaryPower;
  final ValueChanged<bool>? onPowerChanged;

  @override
  Widget build(BuildContext context) {
    final isOnline = device.status == DeviceStatus.online;
    final isOn = primaryPower?.value as bool? ?? device.isPrimaryOn;
    final accent = primaryPower == null
        ? context.colorScheme.primary
        : CapabilityVisuals.accentFor(context, primaryPower!);

    final glowColor = AppPalette.colorForCategory(
      device.productId.contains('light')
          ? 'light'
          : device.productId.contains('security')
              ? 'security'
              : device.productId.contains('roof')
                  ? 'environment'
                  : 'sensor',
    );

    final background = isOn
        ? Color.alphaBlend(
            glowColor.withValues(alpha: 0.8),
            Colors.white.withValues(alpha: 0.9),
          )
        : context.neu.surface;

    return NeuCard(
      color: background,
      padding: const EdgeInsets.all(AppSpacing.lg),
      depth: NeuDepth.raisedStrong,
      glowColor: isOn ? glowColor : null,
      child: LayoutBuilder(
        builder: (context, constraints) {
          final wide = constraints.maxWidth >= 560;
          final identity = _DeviceIdentity(
            device: device,
            isOnline: isOnline,
            isOn: isOn,
            accent: accent,
            icon: primaryPower == null
                ? Icons.devices_other_rounded
                : CapabilityVisuals.iconFor(primaryPower!),
          );
          final power = primaryPower == null
              ? null
              : _PowerControl(
                  capability: primaryPower!,
                  isOnline: isOnline,
                  onChanged: onPowerChanged,
                );

          if (wide && power != null) {
            return Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                Expanded(child: identity),
                const SizedBox(width: AppSpacing.lg),
                SizedBox(width: 184, child: power),
              ],
            );
          }
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              identity,
              if (power != null) ...[
                const SizedBox(height: AppSpacing.lg),
                power,
              ],
            ],
          );
        },
      ),
    );
  }
}

class _DeviceIdentity extends StatelessWidget {
  const _DeviceIdentity({
    required this.device,
    required this.isOnline,
    required this.isOn,
    required this.accent,
    required this.icon,
  });

  final DeviceModel device;
  final bool isOnline;
  final bool isOn;
  final Color accent;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        NeuIconBox(
          icon: icon,
          size: 88,
          iconSize: 40,
          isActive: isOn,
          iconColor: isOn ? accent : context.colorScheme.onSurfaceVariant,
          borderRadius: AppRadius.xl,
        ),
        const SizedBox(width: AppSpacing.md),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                device.name,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: context.textTheme.headlineSmall,
              ),
              const SizedBox(height: AppSpacing.sm),
              Row(
                children: [
                  StatusBadge(status: device.status, size: 14),
                  const SizedBox(width: AppSpacing.sm),
                  Expanded(
                    child: Text(
                      isOnline ? 'Đang kết nối' : 'Ngoại tuyến',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: context.textTheme.bodyMedium?.copyWith(
                        color: isOnline
                            ? context.neu.deviceOnline
                            : context.colorScheme.onSurfaceVariant,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: AppSpacing.sm),
              if (device.topology != null) ...[
                TopologyBadge(topology: device.topology!),
                const SizedBox(height: AppSpacing.sm),
              ],
              Text(
                device.mac,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: context.textTheme.labelSmall?.copyWith(
                  fontFeatures: const [FontFeature.tabularFigures()],
                ),
              ),
              if (device.lastSeen != null) ...[
                const SizedBox(height: AppSpacing.xs),
                Text(
                  'Cập nhật ${_formatLastSeen(device.lastSeen!)}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: context.textTheme.labelSmall,
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }

  String _formatLastSeen(String raw) {
    final parsed = DateTime.tryParse(raw)?.toLocal();
    if (parsed == null) return raw;
    String twoDigits(int value) => value.toString().padLeft(2, '0');
    return '${twoDigits(parsed.hour)}:${twoDigits(parsed.minute)} '
        '${twoDigits(parsed.day)}/${twoDigits(parsed.month)}';
  }
}

class _PowerControl extends StatelessWidget {
  const _PowerControl({
    required this.capability,
    required this.isOnline,
    this.onChanged,
  });

  final CapabilityModel capability;
  final bool isOnline;
  final ValueChanged<bool>? onChanged;

  @override
  Widget build(BuildContext context) {
    final isOn = capability.value as bool? ?? false;
    final disabled = capability.isReadOnly || !isOnline || onChanged == null;
    final accent = CapabilityVisuals.accentFor(context, capability);

    return Semantics(
      container: true,
      label: capability.name,
      toggled: isOn,
      enabled: !disabled,
      child: NeuContainer(
        padding: const EdgeInsets.all(AppSpacing.md),
        borderRadius: AppRadius.lg,
        depth: NeuDepth.pressed,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(
                  CapabilityVisuals.iconFor(capability),
                  size: 20,
                  color: isOn ? accent : context.colorScheme.onSurfaceVariant,
                ),
                const Spacer(),
                NeuToggle(
                  value: isOn,
                  isDisabled: disabled,
                  onChanged: onChanged ?? (_) {},
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.md),
            Text(
              isOnline
                  ? (isOn ? 'Đang bật' : 'Đang tắt')
                  : 'Không thể điều khiển',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: context.textTheme.titleSmall?.copyWith(
                color: isOn ? accent : context.colorScheme.onSurface,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
