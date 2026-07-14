import 'package:flutter/material.dart';
import '../../core.dart';
import '../../widgets/primitives/neu_container.dart';

class NeuBottomBar extends StatelessWidget {
  const NeuBottomBar({
    super.key,
    required this.items,
  });

  final List<Widget> items;

  @override
  Widget build(BuildContext context) {
    return Padding(
      // Padding an toàn cho bottom (Home indicator trên iOS)
      padding: EdgeInsets.only(
        left: AppSpacing.md,
        right: AppSpacing.md,
        bottom: MediaQuery.of(context).padding.bottom + AppSpacing.sm,
        top: AppSpacing.sm,
      ),
      child: NeuContainer(
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.sm,
          vertical: AppSpacing.xs,
        ),
        borderRadius: AppRadius.xl, // Bo góc cong nhiều hơn
        depth: NeuDepth.raisedMedium, // Nổi lên khỏi nền
        child: Row(
          mainAxisAlignment: MainAxisAlignment.spaceAround,
          children: items,
        ),
      ),
    );
  }
}
