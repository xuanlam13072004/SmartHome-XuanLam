import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/core.dart';
import '../../../core/widgets/widgets.dart';
import '../models/room_mock.dart';
import '../providers/rooms_provider.dart';

class RoomCard extends ConsumerWidget {
  const RoomCard({
    super.key,
    required this.room,
    this.onTap,
  });

  final RoomMock room;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Tự động tính toán số thiết bị đang bật trong phòng này
    final activeCount = ref.watch(activeDevicesInRoomProvider(room.name));

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
                  isActive: activeCount > 0,
                  iconColor: activeCount > 0 ? context.colorScheme.primary : null,
                ),
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
              '$activeCount/${room.totalDevices} thiết bị đang bật',
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

