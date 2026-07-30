import 'package:flutter/material.dart';
import '../../../core/core.dart';
import '../../../core/widgets/widgets.dart';
import '../../../domain/models/device_topology.dart';
import 'topology_badge.dart';

class DeviceTopologyPanel extends StatelessWidget {
  const DeviceTopologyPanel({
    super.key,
    required this.topology,
  });

  final DeviceTopology topology;

  @override
  Widget build(BuildContext context) {
    return NeuCard(
      padding: const EdgeInsets.all(AppSpacing.lg),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const NeuIconBox(
                icon: Icons.account_tree_rounded,
                size: 44,
                iconSize: 22,
                isActive: true,
                borderRadius: AppRadius.md,
              ),
              const SizedBox(width: AppSpacing.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Kết nối mạng',
                      style: context.textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      topology.stateLabel,
                      style: context.textTheme.bodySmall?.copyWith(
                        color: context.colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: AppSpacing.sm),
              TopologyBadge(topology: topology),
            ],
          ),
          const SizedBox(height: AppSpacing.lg),
          Wrap(
            spacing: AppSpacing.md,
            runSpacing: AppSpacing.md,
            children: [
              _TopologyFact(
                label: 'Vai trò',
                value: topology.roleLabel,
              ),
              _TopologyFact(
                label: 'Thứ tự ưu tiên',
                value: topology.joinRank == null
                    ? 'Đang đồng bộ'
                    : '#${topology.joinRank}',
              ),
              _TopologyFact(
                label: 'Hub hiện tại',
                value: topology.isHub
                    ? 'Thiết bị này'
                    : _shortMac(topology.activeHubMac),
              ),
              _TopologyFact(
                label: 'Phiên topology',
                value: '#${topology.epoch}',
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.lg),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(AppSpacing.md),
            decoration: BoxDecoration(
              color: context.colorScheme.surfaceContainerHighest
                  .withValues(alpha: 0.45),
              borderRadius: BorderRadius.circular(AppRadius.md),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(
                  topology.usesDirectFallback
                      ? Icons.cloud_done_rounded
                      : topology.isHub
                          ? Icons.hub_rounded
                          : Icons.device_hub_rounded,
                  size: 19,
                  color: topology.isOptimizing || topology.usesDirectFallback
                      ? context.colorScheme.secondary
                      : context.colorScheme.primary,
                ),
                const SizedBox(width: AppSpacing.sm),
                Expanded(
                  child: Text(
                    _description(),
                    style: context.textTheme.bodySmall?.copyWith(height: 1.45),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: AppSpacing.sm),
          Text(
            'Mạng ${_shortNetworkId(topology.networkId)}',
            style: context.textTheme.labelSmall?.copyWith(
              color: context.colorScheme.onSurfaceVariant,
              fontFeatures: const [FontFeature.tabularFigures()],
            ),
          ),
        ],
      ),
    );
  }

  String _description() {
    if (topology.usesDirectFallback || topology.isOptimizing) {
      return 'Thiết bị vẫn duy trì kết nối trực tiếp trong lúc hệ thống '
          'tự chọn và đồng bộ Hub phù hợp.';
    }
    if (topology.isHub) {
      return 'Thiết bị đang làm Hub chính và chuyển tiếp dữ liệu cho các '
          'Node trong cùng mạng.';
    }
    return 'Dữ liệu của thiết bị đang được chuyển tiếp an toàn qua Hub '
        'trong cùng mạng.';
  }

  static String _shortMac(String? value) {
    if (value == null || value.isEmpty) return 'Đang đồng bộ';
    final parts = value.split(':');
    return parts.length >= 2
        ? '••:${parts[parts.length - 2]}:${parts.last}'
        : value;
  }

  static String _shortNetworkId(String value) {
    if (value.length <= 8) return value;
    return '${value.substring(0, 8)}…';
  }
}

class _TopologyFact extends StatelessWidget {
  const _TopologyFact({
    required this.label,
    required this.value,
  });

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 132,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label,
            style: context.textTheme.labelSmall?.copyWith(
              color: context.colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 3),
          Text(
            value,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: context.textTheme.bodyMedium?.copyWith(
              fontWeight: FontWeight.w700,
            ),
          ),
        ],
      ),
    );
  }
}
