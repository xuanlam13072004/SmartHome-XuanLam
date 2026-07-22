import 'package:flutter/material.dart';
import '../../core.dart';
import '../primitives/neu_card.dart';
import '../primitives/neu_icon_box.dart';
import '../indicators/status_badge.dart';
import '../../../features/dashboard/models/capability_model.dart';

/// Thẻ thiết bị tổng hợp (Presentational component) thiết kế dạng Tile (Bento Grid).
class DeviceCard extends StatelessWidget {
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

  @override
  Widget build(BuildContext context) {
    final isOffline = status == DeviceStatus.offline;

    // Lấy thông tin các cảm biến (sensor) để hiển thị lên thẻ
    final sensorCaps =
        capabilities.where((c) => c.type == 'sensor').take(2).toList();

    // Fallback: nếu có brightness/color cũng có thể coi là thông số phụ
    final rangeCaps =
        capabilities.where((c) => c.type == 'range').take(1).toList();

    String subtitleText = subtitle ?? (isOffline ? 'Offline' : 'Online');

    if (subtitle == null && !isOffline) {
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
      onTap: isOffline ? null : onTap,
      behavior: HitTestBehavior.opaque,
      child: AnimatedOpacity(
        duration: const Duration(milliseconds: 200),
        opacity: isOffline ? 0.6 : 1.0,
        child: NeuCard(
          padding: const EdgeInsets.all(AppSpacing.md),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // Top row: Icon and Action
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  NeuIconBox(
                    icon: icon,
                    size: 40,
                    iconSize: 20,
                    iconColor: iconColor,
                    isActive: status == DeviceStatus.online,
                    activeIconColor: iconColor,
                  ),
                  if (actionWidget != null)
                    actionWidget!
                  else
                    Padding(
                      padding: const EdgeInsets.all(4.0),
                      child: StatusBadge(status: status, size: 8),
                    ),
                ],
              ),
              const Spacer(),
              // Bottom row: Title and Sensor Info
              Text(
                title,
                style: context.textTheme.titleMedium?.copyWith(
                  fontWeight: FontWeight.w700,
                  height: 1.2,
                  letterSpacing: -0.3,
                  color: const Color(0xFF1D2939),
                ),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
              ),
              const SizedBox(height: 4),
              Text(
                subtitleText,
                style: context.textTheme.labelMedium?.copyWith(
                  color: isOffline
                      ? const Color(0xFF98A2B3)
                      : context.colorScheme.primary,
                  fontWeight: FontWeight.w600,
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
