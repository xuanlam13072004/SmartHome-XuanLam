// Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V5
// Hallmark · generic workbench · fallback page for Products without a dedicated page
import 'package:flutter/material.dart';

import '../../../core/core.dart';
import '../../../core/widgets/widgets.dart';
import '../../../domain/models/device_model.dart';
import '../../dashboard/models/capability_model.dart';
import '../../dashboard/widgets/capabilities/capability_section_panel.dart';
import '../../dashboard/widgets/device_hero_card.dart';
import '../../dashboard/widgets/device_topology_panel.dart';
import '../product_capability_query.dart';
import 'product_mini_cards.dart';

class GenericProductDetail extends StatelessWidget {
  const GenericProductDetail({
    super.key,
    required this.device,
    required this.onCapabilityChanged,
  });

  final DeviceModel device;
  final ProductCapabilityChanged onCapabilityChanged;

  @override
  Widget build(BuildContext context) {
    final primary = device.primaryOnOff;
    final used = <CapabilityModel>{if (primary != null) primary};
    return ProductDetailWorkbench(
      device: device,
      heroIcon: device.icon,
      primaryPower: primary,
      onCapabilityChanged: onCapabilityChanged,
      summaries: [
        ProductStatusFact(
          icon: Icons.wifi_rounded,
          label: 'Kết nối',
          value: device.status == DeviceStatus.online ? 'Trực tuyến' : 'Ngoại tuyến',
        ),
      ],
      groups: _remainingGroups(device, used),
    );
  }
}

class ProductDetailWorkbench extends StatelessWidget {
  const ProductDetailWorkbench({
    super.key,
    required this.device,
    required this.heroIcon,
    required this.summaries,
    required this.groups,
    required this.onCapabilityChanged,
    this.heroAccent,
    this.primaryPower,
    this.summaryBeforeHero = false,
    this.customSections = const [],
    this.postTopologySections = const [],
  });

  final DeviceModel device;
  final IconData heroIcon;
  final Color? heroAccent;
  final CapabilityModel? primaryPower;
  final List<ProductStatusFact> summaries;
  final List<ProductCapabilityGroup> groups;
  final ProductCapabilityChanged onCapabilityChanged;
  final bool summaryBeforeHero;
  final List<Widget> customSections;
  final List<Widget> postTopologySections;

  @override
  Widget build(BuildContext context) {
    final visibleGroups =
        groups.where((group) => group.capabilities.isNotEmpty);
    final hero = DeviceHeroCard(
      device: device,
      identityIcon: heroIcon,
      identityAccent: heroAccent,
      primaryPower: primaryPower,
      onPowerChanged: primaryPower == null
          ? null
          : (value) => onCapabilityChanged(primaryPower!, value),
    );
    final summary = ProductStatusPanel(facts: summaries);

    return ListView(
      padding: const EdgeInsets.only(top: AppSpacing.md, bottom: 100),
      children: [
        if (summaryBeforeHero) ...[
          summary,
          const SizedBox(height: AppSpacing.xl),
        ],
        hero,
        if (!summaryBeforeHero) ...[
          const SizedBox(height: AppSpacing.xl),
          summary,
        ],
        for (final section in customSections) ...[
          const SizedBox(height: AppSpacing.xl),
          section,
        ],
        if (device.topology != null) ...[
          const SizedBox(height: AppSpacing.xl),
          DeviceTopologyPanel(topology: device.topology!),
        ],
        for (final section in postTopologySections) ...[
          const SizedBox(height: AppSpacing.xl),
          section,
        ],
        for (final group in visibleGroups) ...[
          const SizedBox(height: AppSpacing.xl),
          CapabilitySectionPanel(
            title: group.title,
            description: group.description,
            icon: group.icon,
            capabilities: group.capabilities,
            useGrid: group.useGrid,
            collapsible: group.collapsible,
            initiallyExpanded: group.initiallyExpanded,
            onCapabilityChanged: onCapabilityChanged,
          ),
        ],
        if (device.capabilities.isEmpty) ...[
          const SizedBox(height: AppSpacing.xl),
          const EmptyState(
            icon: Icons.widgets_outlined,
            title: 'Chưa có chức năng',
            description:
                'Thiết bị chưa công bố capability trong Product Catalog.',
          ),
        ],
        const SizedBox(height: AppSpacing.xl),
      ],
    );
  }
}

class ProductStatusFact {
  const ProductStatusFact({
    required this.icon,
    required this.label,
    required this.value,
    this.tone,
  });

  final IconData icon;
  final String label;
  final String value;
  final Color? tone;
}

class ProductStatusPanel extends StatelessWidget {
  const ProductStatusPanel({super.key, required this.facts});

  final List<ProductStatusFact> facts;

  @override
  Widget build(BuildContext context) {
    return NeuCard(
      padding: const EdgeInsets.all(AppSpacing.md),
      child: LayoutBuilder(
        builder: (context, constraints) {
          final columns = constraints.maxWidth >= 680 ? 3 : 1;
          final width = columns == 1
              ? constraints.maxWidth
              : (constraints.maxWidth - AppSpacing.md * (columns - 1)) /
                  columns;
          return Wrap(
            spacing: AppSpacing.md,
            runSpacing: AppSpacing.sm,
            children: facts
                .map((fact) => SizedBox(
                      width: width,
                      child: _StatusFactTile(fact: fact),
                    ))
                .toList(),
          );
        },
      ),
    );
  }
}

class _StatusFactTile extends StatelessWidget {
  const _StatusFactTile({required this.fact});

  final ProductStatusFact fact;

  @override
  Widget build(BuildContext context) {
    final tone = fact.tone ?? context.colorScheme.primary;
    return Semantics(
      label: '${fact.label}: ${fact.value}',
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm),
        child: Row(
          children: [
            NeuIconBox(
              icon: fact.icon,
              size: 40,
              iconSize: 20,
              iconColor: tone,
              activeIconColor: tone,
              isActive: true,
            ),
            const SizedBox(width: AppSpacing.smMd),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(fact.label, style: context.textTheme.labelSmall),
                  const SizedBox(height: AppSpacing.xs),
                  Text(
                    fact.value,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: context.textTheme.titleSmall?.copyWith(
                      color: tone,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class ProductCapabilityGroup {
  const ProductCapabilityGroup({
    required this.title,
    required this.description,
    required this.icon,
    required this.capabilities,
    this.useGrid = false,
    this.collapsible = false,
    this.initiallyExpanded = true,
  });

  final String title;
  final String description;
  final IconData icon;
  final List<CapabilityModel> capabilities;
  final bool useGrid;
  final bool collapsible;
  final bool initiallyExpanded;
}

List<ProductCapabilityGroup> _remainingGroups(
  DeviceModel device,
  Set<CapabilityModel> used,
) {
  List<CapabilityModel> takeSection(CapabilitySection section) {
    final result = device.capabilities
        .where((capability) =>
            capability.section == section && !used.contains(capability))
        .toList();
    used.addAll(result);
    return result;
  }

  return [
    ProductCapabilityGroup(
      title: 'Điều khiển khác',
      description: 'Các thao tác khác được product hỗ trợ',
      icon: Icons.tune_rounded,
      capabilities: takeSection(CapabilitySection.control),
    ),
    ProductCapabilityGroup(
      title: 'Thông số khác',
      description: 'Dữ liệu mới nhất do thiết bị báo cáo',
      icon: Icons.sensors_rounded,
      capabilities: takeSection(CapabilitySection.sensor),
      useGrid: true,
    ),
  ];
}
