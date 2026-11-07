// Hallmark · product page kit · state first → one obvious action → readings → settings → activity
//
// Building blocks shared by the product pages. A page answers "what is it
// doing now?" in the header, offers the main action as one large control,
// then shows readings as tiles and rarely used settings as a list. Technical
// details (diagnostics, MAC, Hub–Node internals) stay out of the page; the
// Hub–Node state is one tap away in the connection chip.
import 'package:flutter/material.dart';

import '../../../core/core.dart';
import '../../../core/widgets/widgets.dart';
import '../../../domain/models/device_model.dart';
import '../../../domain/models/device_topology.dart';
import '../../dashboard/models/capability_model.dart';
import '../../dashboard/widgets/device_topology_panel.dart';

/// Scrollable body of a product page with even spacing between sections.
class ProductPage extends StatelessWidget {
  const ProductPage({super.key, required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) => ListView(
        padding: const EdgeInsets.only(top: AppSpacing.md, bottom: 96),
        children: [
          for (var index = 0; index < children.length; index++) ...[
            if (index > 0) const SizedBox(height: AppSpacing.lg),
            children[index],
          ],
        ],
      );
}

bool productOnline(DeviceModel device) => device.status == DeviceStatus.online;

/// Copy of [source] that can run exactly [operationName], or null when the
/// account may not run it.
CapabilityModel? capabilityForOperation(CapabilityModel? source, String operationName) {
  if (source == null) return null;
  final matches = source.operations
      .where((operation) => operation.operationName == operationName)
      .toList(growable: false);
  if (matches.length != 1) return null;
  return source.copyWith(isReadOnly: false, operations: [matches.single]);
}

CapabilityModel? productProperty(
  DeviceModel device, {
  required String capabilityId,
  required String propertyId,
}) {
  for (final capability in device.capabilities) {
    if (capability.capabilityId == capabilityId && capability.id == propertyId) {
      return capability;
    }
  }
  return null;
}

String productText(CapabilityModel? capability) =>
    '${capability?.value ?? ''}'.trim().toLowerCase();

/// Header: what the device is doing now, whether it is reachable, and its
/// Hub–Node connection (tap for details).
class ProductStatusHeader extends StatelessWidget {
  const ProductStatusHeader({
    super.key,
    required this.device,
    required this.icon,
    required this.status,
    this.detail,
    this.tone,
    this.showConnection = true,
  });

  final DeviceModel device;
  final IconData icon;
  final String status;
  final String? detail;
  final Color? tone;
  final bool showConnection;

  @override
  Widget build(BuildContext context) {
    final online = productOnline(device);
    final color = online ? (tone ?? context.colorScheme.primary) : context.colorScheme.onSurfaceVariant;
    final subtitle = online
        ? (detail ?? 'Đang hoạt động')
        : 'Thiết bị đang ngoại tuyến. Lệnh sẽ khả dụng khi thiết bị kết nối lại.';
    final topology = device.topology;
    return Semantics(
      container: true,
      liveRegion: true,
      label: '${online ? status : 'Ngoại tuyến'}. $subtitle',
      child: NeuCard(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Row(
          children: [
            ProductToneIcon(icon: online ? icon : Icons.cloud_off_rounded, tone: color, size: 52),
            const SizedBox(width: AppSpacing.md),
            Expanded(
              child: ExcludeSemantics(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      online ? status : 'Ngoại tuyến',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: context.textTheme.titleLarge?.copyWith(
                        color: color,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      subtitle,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: context.textTheme.bodySmall?.copyWith(
                        color: context.colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
            ),
            if (showConnection && topology != null) ...[
              const SizedBox(width: AppSpacing.sm),
              _ConnectionChip(topology: topology),
            ],
          ],
        ),
      ),
    );
  }
}

class _ConnectionChip extends StatelessWidget {
  const _ConnectionChip({required this.topology});

  final DeviceTopology topology;

  @override
  Widget build(BuildContext context) {
    final icon = switch (topology.transportMode) {
      DeviceTransportMode.hub => Icons.hub_rounded,
      DeviceTransportMode.relay => Icons.device_hub_rounded,
      DeviceTransportMode.directFallback => Icons.wifi_rounded,
      _ => Icons.lan_rounded,
    };
    return Tooltip(
      message: 'Kết nối mạng: ${topology.stateLabel}',
      child: InkWell(
        borderRadius: BorderRadius.circular(AppRadius.full),
        onTap: () => showModalBottomSheet<void>(
          context: context,
          showDragHandle: true,
          isScrollControlled: true,
          builder: (sheetContext) => SafeArea(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, AppSpacing.lg),
              child: DeviceTopologyPanel(topology: topology),
            ),
          ),
        ),
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: context.colorScheme.primary.withValues(alpha: 0.10),
            borderRadius: BorderRadius.circular(AppRadius.full),
          ),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(icon, size: 15, color: context.colorScheme.primary),
                const SizedBox(width: 4),
                Text(
                  topology.connectionLabel,
                  style: context.textTheme.labelSmall?.copyWith(
                    color: context.colorScheme.primary,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Icon on a soft tinted circle.
class ProductToneIcon extends StatelessWidget {
  const ProductToneIcon({super.key, required this.icon, required this.tone, this.size = 40});

  final IconData icon;
  final Color tone;
  final double size;

  @override
  Widget build(BuildContext context) => DecoratedBox(
        decoration: BoxDecoration(
          color: tone.withValues(alpha: 0.13),
          shape: BoxShape.circle,
        ),
        child: SizedBox.square(
          dimension: size,
          child: Icon(icon, color: tone, size: size * 0.5),
        ),
      );
}

/// The one big round control of a page (lock, water now…). The whole column,
/// including its label, is the touch target.
class ProductPrimaryControl extends StatelessWidget {
  const ProductPrimaryControl({
    super.key,
    required this.icon,
    required this.label,
    required this.tone,
    this.caption,
    this.active = false,
    this.busy = false,
    this.onPressed,
    this.size = 132,
  });

  final IconData icon;
  final String label;
  final String? caption;
  final Color tone;
  final bool active;
  final bool busy;
  final VoidCallback? onPressed;
  final double size;

  @override
  Widget build(BuildContext context) {
    final enabled = onPressed != null && !busy;
    final iconColor = enabled || busy ? tone : context.colorScheme.onSurfaceVariant.withValues(alpha: 0.5);
    return Semantics(
      button: true,
      enabled: enabled,
      label: label,
      child: MouseRegion(
        cursor: enabled ? SystemMouseCursors.click : SystemMouseCursors.basic,
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: enabled ? onPressed : null,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              NeuContainer(
                width: size,
                height: size,
                shape: BoxShape.circle,
                depth: active ? NeuDepth.pressed : NeuDepth.raisedStrong,
                glowColor: active && enabled ? tone.withValues(alpha: 0.55) : null,
                child: Center(
                  child: busy
                      ? SizedBox.square(
                          dimension: size * 0.3,
                          child: CircularProgressIndicator(strokeWidth: 3, color: tone),
                        )
                      : Icon(icon, size: size * 0.38, color: iconColor),
                ),
              ),
              const SizedBox(height: AppSpacing.md),
              ExcludeSemantics(
                child: Text(
                  label,
                  textAlign: TextAlign.center,
                  style: context.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700),
                ),
              ),
              if (caption != null) ...[
                const SizedBox(height: AppSpacing.xs),
                ExcludeSemantics(
                  child: Text(
                    caption!,
                    textAlign: TextAlign.center,
                    style: context.textTheme.bodySmall?.copyWith(
                      color: context.colorScheme.onSurfaceVariant,
                    ),
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// Large square action used in pairs (open / close).
class ProductActionTile extends StatelessWidget {
  const ProductActionTile({
    super.key,
    required this.icon,
    required this.label,
    required this.tone,
    this.active = false,
    this.busy = false,
    this.onPressed,
  });

  final IconData icon;
  final String label;
  final Color tone;
  final bool active;
  final bool busy;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final enabled = onPressed != null && !busy;
    final color = active || enabled ? tone : context.colorScheme.onSurfaceVariant.withValues(alpha: 0.5);
    return Semantics(
      button: true,
      enabled: enabled,
      selected: active,
      label: label,
      child: MouseRegion(
        cursor: enabled ? SystemMouseCursors.click : SystemMouseCursors.basic,
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: enabled ? onPressed : null,
          child: NeuContainer(
            height: 104,
            borderRadius: AppRadius.lg,
            depth: active ? NeuDepth.pressed : NeuDepth.raisedMedium,
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                busy
                    ? SizedBox.square(
                        dimension: 26,
                        child: CircularProgressIndicator(strokeWidth: 2.5, color: tone),
                      )
                    : Icon(icon, size: 30, color: color),
                const SizedBox(height: AppSpacing.sm),
                ExcludeSemantics(
                  child: Text(
                    label,
                    style: context.textTheme.titleSmall?.copyWith(
                      fontWeight: FontWeight.w700,
                      color: active ? tone : null,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class ProductReading {
  const ProductReading({
    required this.icon,
    required this.label,
    required this.value,
    this.caption,
    this.tone,
  });

  final IconData icon;
  final String label;
  final String value;
  final String? caption;
  final Color? tone;
}

/// Readings as tiles: two per row on phones, three on wide screens.
class ProductReadingGrid extends StatelessWidget {
  const ProductReadingGrid({super.key, required this.readings});

  final List<ProductReading> readings;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
        builder: (context, constraints) {
          const gap = AppSpacing.smMd;
          final columns = constraints.maxWidth >= 600 ? 3 : 2;
          final width = (constraints.maxWidth - gap * (columns - 1)) / columns;
          return Wrap(
            spacing: gap,
            runSpacing: gap,
            children: [
              for (final reading in readings)
                SizedBox(width: width, child: _ReadingTile(reading: reading)),
            ],
          );
        },
      );
}

class _ReadingTile extends StatelessWidget {
  const _ReadingTile({required this.reading});

  final ProductReading reading;

  @override
  Widget build(BuildContext context) {
    final tone = reading.tone ?? context.colorScheme.primary;
    return Semantics(
      label: '${reading.label}: ${reading.value}${reading.caption == null ? '' : ', ${reading.caption}'}',
      child: ExcludeSemantics(
        child: NeuCard(
          padding: const EdgeInsets.all(14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(reading.icon, size: 18, color: tone),
                  const SizedBox(width: AppSpacing.xs),
                  Expanded(
                    child: Text(
                      reading.label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: context.textTheme.labelMedium?.copyWith(
                        color: context.colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: AppSpacing.sm),
              Text(
                reading.value,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: context.textTheme.titleLarge?.copyWith(
                  fontWeight: FontWeight.w700,
                  color: reading.tone,
                ),
              ),
              if (reading.caption != null) ...[
                const SizedBox(height: 2),
                Text(
                  reading.caption!,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: context.textTheme.labelSmall?.copyWith(
                    color: context.colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class ProductSectionTitle extends StatelessWidget {
  const ProductSectionTitle(this.title, {super.key, this.trailing});

  final String title;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(left: AppSpacing.xs),
        child: Row(
          children: [
            Expanded(
              child: Text(
                title,
                style: context.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700),
              ),
            ),
            if (trailing != null) trailing!,
          ],
        ),
      );
}

/// Section title followed by its content.
class ProductSection extends StatelessWidget {
  const ProductSection({super.key, required this.title, required this.child, this.trailing});

  final String title;
  final Widget child;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ProductSectionTitle(title, trailing: trailing),
          const SizedBox(height: AppSpacing.sm),
          child,
        ],
      );
}

/// Rows of settings in one card, separated by thin dividers.
class ProductSettingsCard extends StatelessWidget {
  const ProductSettingsCard({super.key, required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) => NeuCard(
        padding: const EdgeInsets.symmetric(vertical: AppSpacing.xs),
        child: Column(
          children: [
            for (var index = 0; index < children.length; index++) ...[
              if (index > 0)
                Divider(
                  height: 1,
                  indent: 68,
                  endIndent: AppSpacing.md,
                  color: context.colorScheme.outlineVariant.withValues(alpha: 0.6),
                ),
              children[index],
            ],
          ],
        ),
      );
}

class ProductSettingTile extends StatelessWidget {
  const ProductSettingTile({
    super.key,
    required this.icon,
    required this.title,
    this.subtitle,
    this.trailing,
    this.onTap,
    this.enabled = true,
    this.tone,
  });

  final IconData icon;
  final String title;
  final String? subtitle;
  final Widget? trailing;
  final VoidCallback? onTap;
  final bool enabled;
  final Color? tone;

  @override
  Widget build(BuildContext context) => ListTile(
        enabled: enabled,
        onTap: onTap,
        contentPadding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
        leading: ProductToneIcon(icon: icon, tone: tone ?? context.colorScheme.primary),
        title: Text(title, style: context.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600)),
        subtitle: subtitle == null
            ? null
            : Text(
                subtitle!,
                style: context.textTheme.bodySmall?.copyWith(
                  color: context.colorScheme.onSurfaceVariant,
                ),
              ),
        trailing: trailing ?? (onTap == null ? null : const Icon(Icons.chevron_right_rounded)),
      );
}

/// Small tinted note (warnings, short explanations).
class ProductNotice extends StatelessWidget {
  const ProductNotice({super.key, required this.icon, required this.text, this.tone});

  final IconData icon;
  final String text;
  final Color? tone;

  @override
  Widget build(BuildContext context) {
    final color = tone ?? context.colorScheme.primary;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(AppRadius.smMd),
      ),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.smMd),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icon, size: 18, color: color),
            const SizedBox(width: AppSpacing.sm),
            Expanded(child: Text(text, style: context.textTheme.bodySmall)),
          ],
        ),
      ),
    );
  }
}

/// Inline spinner used inside buttons while a command is in flight.
class ProductButtonSpinner extends StatelessWidget {
  const ProductButtonSpinner({super.key});

  @override
  Widget build(BuildContext context) => const SizedBox.square(
        dimension: 18,
        child: CircularProgressIndicator(strokeWidth: 2),
      );
}

String productDurationLabel(int seconds) {
  if (seconds < 60) return '$seconds giây';
  if (seconds % 60 == 0) return '${seconds ~/ 60} phút';
  return '${seconds ~/ 60} phút ${seconds % 60} giây';
}

String productClock(DateTime time) {
  final local = time.toLocal();
  String two(int value) => value.toString().padLeft(2, '0');
  return '${two(local.hour)}:${two(local.minute)}';
}
