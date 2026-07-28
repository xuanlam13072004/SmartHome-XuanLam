import 'package:flutter/material.dart';
import '../../core.dart';
import '../primitives/neu_container.dart';
import '../primitives/neu_icon_box.dart';
import '../indicators/status_badge.dart';
import '../../../features/dashboard/models/capability_model.dart';

/// Thẻ thiết bị — Hallmark Premium Neumorphic.
/// Glow effect khi thiết bị ON, icon animation pulse, improved hierarchy.
class DeviceCard extends StatefulWidget {
  const DeviceCard({
    super.key,
    required this.title,
    required this.icon,
    required this.status,
    this.subtitle,
    this.iconColor,
    this.actionWidget,
    this.onTap,
    this.capabilities = const [],
    this.glowColor,
    this.isPrimaryOn = false,
  });

  final String title;
  final IconData icon;
  final DeviceStatus status;
  final String? subtitle;
  final Color? iconColor;
  final Widget? actionWidget;
  final VoidCallback? onTap;

  /// Danh sách các capabilities để lấy thông tin sensor hiển thị.
  final List<CapabilityModel> capabilities;

  /// Hallmark: Glow color cho card khi thiết bị ON.
  final Color? glowColor;

  /// Thiết bị đang bật (primary capability ON).
  final bool isPrimaryOn;

  @override
  State<DeviceCard> createState() => _DeviceCardState();
}

class _DeviceCardState extends State<DeviceCard>
    with SingleTickerProviderStateMixin {
  late AnimationController _tapController;
  late Animation<double> _tapScale;

  @override
  void initState() {
    super.initState();
    _tapController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 80),
      reverseDuration: const Duration(milliseconds: 120),
    );
    _tapScale = Tween<double>(begin: 1.0, end: 0.96).animate(
      CurvedAnimation(parent: _tapController, curve: Curves.easeOutCubic),
    );
  }

  @override
  void dispose() {
    _tapController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final isOffline = widget.status == DeviceStatus.offline;
    final isOn = widget.isPrimaryOn && !isOffline;

    // Lấy thông tin các cảm biến (sensor) để hiển thị lên thẻ
    final sensorCaps =
        widget.capabilities.where((c) => c.type == 'sensor').take(2).toList();
    final rangeCaps =
        widget.capabilities.where((c) => c.type == 'range').take(1).toList();

    String subtitleText = widget.subtitle ?? (isOffline ? 'Offline' : 'Online');

    if (widget.subtitle == null && !isOffline) {
      if (sensorCaps.isNotEmpty) {
        subtitleText = sensorCaps.map((c) {
          final val = c.value is double
              ? (c.value as double).toStringAsFixed(1)
              : c.value.toString();
          final unit = c.properties['unit'] ?? '';
          return '$val$unit';
        }).join(' • ');
      } else if (rangeCaps.isNotEmpty) {
        final c = rangeCaps.first;
        final val = c.value is double ? (c.value as double).toInt() : c.value;
        subtitleText = '${c.name}: $val${c.properties['unit'] ?? '%'}';
      }
    }

    return GestureDetector(
      onTapDown: (_) => _tapController.forward(),
      onTapUp: (_) {
        _tapController.reverse();
        if (!isOffline) widget.onTap?.call();
      },
      onTapCancel: () => _tapController.reverse(),
      behavior: HitTestBehavior.opaque,
      child: ScaleTransition(
        scale: _tapScale,
        child: AnimatedOpacity(
          duration: const Duration(milliseconds: 250),
          opacity: isOffline ? 0.55 : 1.0,
          child: NeuContainer(
            padding: const EdgeInsets.all(AppSpacing.md),
            borderRadius: AppRadius.lg,
            depth: NeuDepth.raisedMedium,
            // Hallmark Colorful: Khi ON, tint toàn bộ thẻ bằng màu accent pha với trắng
            color: isOn && widget.glowColor != null
                ? Color.alphaBlend(
                    widget.glowColor!.withValues(alpha: 0.8), // 80% glow color, the rest is surface
                    Colors.white.withValues(alpha: 0.9), // Bright base for lively look
                  )
                : null,
            // Vẫn giữ glow lan tỏa nếu muốn
            glowColor: isOn ? widget.glowColor : null,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // Top row: Icon and Action
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    NeuIconBox(
                      icon: widget.icon,
                      size: 44,
                      iconSize: 22,
                      iconColor: widget.iconColor,
                      isActive: widget.status == DeviceStatus.online,
                      activeIconColor: widget.iconColor,
                    ),
                    if (widget.actionWidget != null)
                      widget.actionWidget!
                    else
                      Padding(
                        padding: const EdgeInsets.all(4.0),
                        child: StatusBadge(status: widget.status, size: 8),
                      ),
                  ],
                ),
                const Spacer(),
                // Bottom: Title + Subtitle
                Text(
                  widget.title,
                  style: context.textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w700,
                    height: 1.2,
                    letterSpacing: -0.3,
                    // Hallmark: dùng theme token thay vì hardcode color
                    color: context.colorScheme.onSurface,
                  ),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: 4),
                Row(
                  children: [
                    // Hallmark: Online dot nhỏ
                    if (!isOffline) ...[
                      Container(
                        width: 6,
                        height: 6,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          color: isOn
                              ? context.colorScheme.primary
                              : context.neu.deviceOnline,
                        ),
                      ),
                      const SizedBox(width: 5),
                    ],
                    Expanded(
                      child: Text(
                        subtitleText,
                        style: context.textTheme.labelMedium?.copyWith(
                          color: isOffline
                              ? context.colorScheme.onSurfaceVariant
                                  .withValues(alpha: 0.5)
                              : context.colorScheme.onSurfaceVariant,
                          fontWeight: FontWeight.w500,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
