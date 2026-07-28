import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../../../../core/core.dart';
import '../../../../core/widgets/widgets.dart';
import '../../models/capability_model.dart';
import 'capability_visuals.dart';

/// Hallmark Premium: Mode selector với animated chips + icons.
class CapabilityModeWidget extends StatelessWidget {
  const CapabilityModeWidget({
    super.key,
    required this.capability,
    required this.onChanged,
  });

  final CapabilityModel capability;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    final String currentValue = (capability.value as String?) ?? '';
    final List<String> options =
        (capability.properties['options'] as List<dynamic>?)
                ?.map((e) => e.toString())
                .toList() ??
            [];

    final accent = CapabilityVisuals.accentFor(context, capability);

    return NeuCard(
      padding: const EdgeInsets.all(AppSpacing.md),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          CapabilityHeading(
            capability: capability,
            subtitle: currentValue.isNotEmpty
                ? CapabilityVisuals.optionLabel(currentValue)
                : null,
          ),
          const SizedBox(height: AppSpacing.md),
          Wrap(
            spacing: AppSpacing.sm,
            runSpacing: AppSpacing.sm,
            children: options.map((option) {
              final selected = currentValue == option;
              return _ModeChip(
                label: CapabilityVisuals.optionLabel(option),
                icon: CapabilityVisuals.optionIcon(option),
                selected: selected,
                accent: accent,
                isReadOnly: capability.isReadOnly,
                onSelected: () {
                  HapticFeedback.selectionClick();
                  onChanged(option);
                },
              );
            }).toList(),
          ),
        ],
      ),
    );
  }
}

/// Hallmark: Animated chip với scale feedback khi tap.
class _ModeChip extends StatefulWidget {
  const _ModeChip({
    required this.label,
    required this.icon,
    required this.selected,
    required this.accent,
    required this.isReadOnly,
    required this.onSelected,
  });

  final String label;
  final IconData icon;
  final bool selected;
  final Color accent;
  final bool isReadOnly;
  final VoidCallback onSelected;

  @override
  State<_ModeChip> createState() => _ModeChipState();
}

class _ModeChipState extends State<_ModeChip>
    with SingleTickerProviderStateMixin {
  late AnimationController _controller;
  late Animation<double> _scale;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 80),
      reverseDuration: const Duration(milliseconds: 100),
    );
    _scale = Tween<double>(begin: 1.0, end: 0.93).animate(
      CurvedAnimation(parent: _controller, curve: Curves.easeOutCubic),
    );
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTapDown: widget.isReadOnly ? null : (_) => _controller.forward(),
      onTapUp: widget.isReadOnly
          ? null
          : (_) {
              _controller.reverse();
              widget.onSelected();
            },
      onTapCancel: () => _controller.reverse(),
      child: ScaleTransition(
        scale: _scale,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOutCubic,
          padding: const EdgeInsets.symmetric(
            horizontal: AppSpacing.smMd,
            vertical: AppSpacing.sm,
          ),
          decoration: BoxDecoration(
            color: widget.selected
                ? widget.accent
                : context.colorScheme.surfaceContainerLow,
            borderRadius: BorderRadius.circular(AppRadius.full),
            border: Border.all(
              color: widget.selected
                  ? Colors.transparent
                  : context.colorScheme.outlineVariant,
              width: 1,
            ),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                widget.icon,
                size: 18,
                color: widget.selected
                    ? context.colorScheme.onPrimary
                    : context.colorScheme.onSurfaceVariant,
              ),
              const SizedBox(width: 6),
              Text(
                widget.label,
                style: context.textTheme.labelLarge?.copyWith(
                  color: widget.selected
                      ? context.colorScheme.onPrimary
                      : context.colorScheme.onSurfaceVariant,
                  fontWeight:
                      widget.selected ? FontWeight.w700 : FontWeight.w500,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
