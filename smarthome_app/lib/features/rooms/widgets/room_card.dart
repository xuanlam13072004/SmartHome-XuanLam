import 'package:flutter/material.dart';
import '../../../core/core.dart';
import '../../../core/widgets/widgets.dart';
import '../models/room_mock.dart';

class RoomCard extends StatelessWidget {
  const RoomCard({
    super.key,
    required this.room,
    this.onTap,
  });

  final RoomMock room;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: NeuCard(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                NeuIconBox(
                  icon: room.icon,
                  isActive: room.activeDevices > 0,
                  iconColor: room.activeDevices > 0 ? context.colorScheme.primary : null,
                ),
                // Có thể thêm nút settings nhỏ ở đây
                Icon(
                  Icons.more_vert,
                  color: context.colorScheme.onSurfaceVariant.withValues(alpha: 0.5),
                  size: 20,
                ),
              ],
            ),
            const Spacer(),
            Text(
              room.name,
              style: context.textTheme.titleMedium?.copyWith(
                fontWeight: FontWeight.bold,
              ),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            const SizedBox(height: 4),
            Text(
              '${room.activeDevices}/${room.totalDevices} thiết bị đang bật',
              style: context.textTheme.bodySmall?.copyWith(
                color: context.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
