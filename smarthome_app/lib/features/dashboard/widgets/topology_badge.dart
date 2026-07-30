import 'package:flutter/material.dart';
import '../../../core/core.dart';
import '../../../domain/models/device_topology.dart';

class TopologyBadge extends StatelessWidget {
  const TopologyBadge({
    super.key,
    required this.topology,
    this.compact = false,
  });

  final DeviceTopology topology;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final color = _color(context);
    final label =
        topology.isOptimizing ? 'Đang tối ưu' : topology.connectionLabel;

    return Semantics(
      label: '${topology.roleLabel}, $label',
      child: Container(
        padding: EdgeInsets.symmetric(
          horizontal: compact ? 7 : 10,
          vertical: compact ? 4 : 6,
        ),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.12),
          borderRadius: BorderRadius.circular(AppRadius.full),
          border: Border.all(color: color.withValues(alpha: 0.2)),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(_icon(), size: compact ? 12 : 15, color: color),
            SizedBox(width: compact ? 4 : 6),
            Flexible(
              child: Text(
                label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: (compact
                        ? context.textTheme.labelSmall
                        : context.textTheme.labelMedium)
                    ?.copyWith(
                  color: color,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Color _color(BuildContext context) {
    if (topology.isOptimizing || topology.usesDirectFallback) {
      return context.colorScheme.secondary;
    }
    if (topology.isHub) return context.colorScheme.primary;
    return context.neu.deviceOnline;
  }

  IconData _icon() {
    if (topology.isOptimizing) return Icons.sync_rounded;
    return switch (topology.transportMode) {
      DeviceTransportMode.hub => Icons.hub_rounded,
      DeviceTransportMode.relay => Icons.device_hub_rounded,
      DeviceTransportMode.directFallback => Icons.cloud_done_rounded,
      DeviceTransportMode.offline => Icons.cloud_off_rounded,
      DeviceTransportMode.unknown => Icons.help_outline_rounded,
    };
  }
}
