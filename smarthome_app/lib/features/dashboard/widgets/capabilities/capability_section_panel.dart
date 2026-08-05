import 'package:flutter/material.dart';
import '../../../../core/core.dart';
import '../../../../core/widgets/widgets.dart';
import '../../models/capability_model.dart';
import 'capability_registry.dart';

class CapabilitySectionPanel extends StatefulWidget {
  const CapabilitySectionPanel({
    super.key,
    required this.title,
    required this.description,
    required this.icon,
    required this.capabilities,
    required this.onCapabilityChanged,
    this.useGrid = false,
    this.collapsible = false,
    this.initiallyExpanded = true,
  });

  final String title;
  final String description;
  final IconData icon;
  final List<CapabilityModel> capabilities;
  final void Function(CapabilityModel capability, dynamic value)
      onCapabilityChanged;
  final bool useGrid;
  final bool collapsible;
  final bool initiallyExpanded;

  @override
  State<CapabilitySectionPanel> createState() => _CapabilitySectionPanelState();
}

class _CapabilitySectionPanelState extends State<CapabilitySectionPanel> {
  late bool _expanded = widget.initiallyExpanded;

  @override
  Widget build(BuildContext context) {
    if (widget.capabilities.isEmpty) return const SizedBox.shrink();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _SectionHeader(
          title: widget.title,
          description: widget.description,
          icon: widget.icon,
          count: widget.capabilities.length,
          expanded: _expanded,
          collapsible: widget.collapsible,
          onToggle: widget.collapsible
              ? () => setState(() => _expanded = !_expanded)
              : null,
        ),
        if (_expanded) ...[
          const SizedBox(height: AppSpacing.md),
          LayoutBuilder(
            builder: (context, constraints) {
              final columnCount =
                  widget.useGrid && constraints.maxWidth >= 680 ? 2 : 1;
              final itemWidth = columnCount == 1
                  ? constraints.maxWidth
                  : (constraints.maxWidth - AppSpacing.md) / 2;
              return Wrap(
                spacing: AppSpacing.md,
                runSpacing: AppSpacing.md,
                children: widget.capabilities.map((capability) {
                  return SizedBox(
                    width: itemWidth,
                    child: capabilityRegistry.buildWidget(
                      context,
                      capability,
                      (value) =>
                          widget.onCapabilityChanged(capability, value),
                    ),
                  );
                }).toList(),
              );
            },
          ),
        ],
      ],
    );
  }
}

class _SectionHeader extends StatelessWidget {
  const _SectionHeader({
    required this.title,
    required this.description,
    required this.icon,
    required this.count,
    required this.expanded,
    required this.collapsible,
    this.onToggle,
  });

  final String title;
  final String description;
  final IconData icon;
  final int count;
  final bool expanded;
  final bool collapsible;
  final VoidCallback? onToggle;

  @override
  Widget build(BuildContext context) {
    final content = Row(
      children: [
        NeuContainer(
          width: 44,
          height: 44,
          borderRadius: AppRadius.md,
          depth: NeuDepth.pressed,
          child: Icon(
            icon,
            size: 22,
            color: context.colorScheme.primary,
          ),
        ),
        const SizedBox(width: AppSpacing.smMd),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title, style: context.textTheme.titleLarge),
              const SizedBox(height: AppSpacing.xs),
              Text(
                description,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: context.textTheme.bodySmall,
              ),
            ],
          ),
        ),
        const SizedBox(width: AppSpacing.sm),
        DecoratedBox(
          decoration: BoxDecoration(
            color: context.colorScheme.primary.withValues(alpha: 0.1),
            borderRadius: BorderRadius.circular(AppRadius.full),
          ),
          child: Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpacing.smMd,
              vertical: AppSpacing.sm,
            ),
            child: Text(
              '$count',
              style: context.textTheme.labelMedium?.copyWith(
                color: context.colorScheme.primary,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
        ),
        if (collapsible) ...[
          const SizedBox(width: AppSpacing.xs),
          Icon(
            expanded
                ? Icons.keyboard_arrow_up_rounded
                : Icons.keyboard_arrow_down_rounded,
            color: context.colorScheme.onSurfaceVariant,
          ),
        ],
      ],
    );

    if (!collapsible) return content;
    return Semantics(
      button: true,
      expanded: expanded,
      label: title,
      child: InkWell(
        onTap: onToggle,
        borderRadius: BorderRadius.circular(AppRadius.md),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: AppSpacing.xs),
          child: content,
        ),
      ),
    );
  }
}
