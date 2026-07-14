import 'package:flutter/material.dart';
import '../../../core/core.dart';
import '../../../core/widgets/widgets.dart';
import '../models/scene_mock.dart';

class SceneCard extends StatelessWidget {
  const SceneCard({
    super.key,
    required this.scene,
    this.onTap,
  });

  final SceneMock scene;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final primaryColor = context.colorScheme.primary;
    final isActive = scene.isActive;

    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: NeuCard(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Row(
          children: [
            NeuIconBox(
              icon: scene.icon,
              isActive: isActive,
              iconColor: isActive ? primaryColor : null,
              shape: BoxShape.circle,
            ),
            const SizedBox(width: AppSpacing.md),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    scene.name,
                    style: context.textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    scene.description,
                    style: context.textTheme.bodySmall?.copyWith(
                      color: context.colorScheme.onSurfaceVariant,
                    ),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
              ),
            ),
            const SizedBox(width: AppSpacing.md),
            // Nút kích hoạt hoặc trạng thái đang chạy
            isActive
                ? NeuButton.icon(
                    Icons.stop_rounded,
                    onPressed: onTap ?? () {},
                    // Có thể tuỳ biến màu sắc cho nút stop
                  )
                : NeuButton.icon(
                    Icons.play_arrow_rounded,
                    onPressed: onTap ?? () {},
                  ),
          ],
        ),
      ),
    );
  }
}
