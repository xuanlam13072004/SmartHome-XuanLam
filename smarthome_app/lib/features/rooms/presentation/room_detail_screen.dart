import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/core.dart';
import '../../../core/widgets/widgets.dart';
import '../../../domain/models/device_model.dart';
import '../../dashboard/presentation/capability_actions.dart';
import '../../dashboard/providers/devices_provider.dart';
import '../../products/product_ui_registry.dart';
import '../data/room_models.dart';
import '../providers/rooms_providers.dart';
import '../room_icons.dart';
import '../room_insights.dart';
import '../widgets/room_card.dart';
import '../widgets/room_quick_controls.dart';
import 'room_actions.dart';
import 'room_devices_sheet.dart';
import 'room_editor_sheet.dart';

/// One room: its live state, one-tap controls, and its devices.
class RoomDetailScreen extends ConsumerWidget {
  const RoomDetailScreen({super.key, required this.roomId});

  final String roomId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final roomsAsync = ref.watch(roomsProvider);
    final list = roomsAsync.valueOrNull;
    final room = list?.byId(roomId);

    if (room == null) {
      return PageScaffold(
        scrollable: false,
        appBar: AppBar(title: const Text('Phòng')),
        child: roomsAsync.isLoading
            ? const Center(child: CircularProgressIndicator())
            : const Center(
                child: EmptyState(
                  icon: Icons.meeting_room_rounded,
                  title: 'Không tìm thấy phòng',
                  description: 'Phòng này không còn tồn tại.',
                ),
              ),
      );
    }

    final devices = ref.watch(devicesProvider).valueOrNull ?? const <DeviceModel>[];
    final inRoom = RoomGroups(list!.rooms, devices).of(room.id);
    final summary = summarizeRoom(inRoom);

    return PageScaffold(
      scrollable: false,
      appBar: AppBar(
        title: Text(room.name),
        actions: [
          IconButton(
            tooltip: 'Đổi tên, biểu tượng',
            icon: const Icon(Icons.edit_rounded),
            onPressed: () => showRoomEditor(context, room: room),
          ),
          PopupMenuButton<String>(
            onSelected: (value) {
              if (value == 'devices') showRoomDevicesSheet(context, room);
              if (value == 'delete') {
                // Leave this page first so it never shows a missing room.
                deleteRoom(context, ref, room, beforeDelete: () => context.pop());
              }
            },
            itemBuilder: (context) => [
              const PopupMenuItem(
                value: 'devices',
                child: ListTile(leading: Icon(Icons.checklist_rounded), title: Text('Chọn thiết bị')),
              ),
              PopupMenuItem(
                value: 'delete',
                child: ListTile(
                  leading: Icon(Icons.delete_outline_rounded, color: context.colorScheme.error),
                  title: Text('Xóa phòng', style: TextStyle(color: context.colorScheme.error)),
                ),
              ),
            ],
          ),
        ],
      ),
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
      child: CustomScrollView(
        slivers: [
          SliverToBoxAdapter(child: _RoomHeader(room: room, summary: summary)),
          if (inRoom.isNotEmpty) ...[
            const SliverToBoxAdapter(child: SizedBox(height: AppSpacing.md)),
            const SliverToBoxAdapter(child: SectionTitle(title: 'Điều khiển nhanh')),
            SliverToBoxAdapter(child: RoomQuickControls(devices: inRoom)),
          ],
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.only(top: AppSpacing.md),
              child: SectionTitle(
                title: 'Thiết bị (${inRoom.length})',
                actionText: inRoom.isEmpty ? null : 'Chọn thiết bị',
                onActionTap: () => showRoomDevicesSheet(context, room),
              ),
            ),
          ),
          if (inRoom.isEmpty)
            SliverToBoxAdapter(
              child: EmptyState(
                icon: roomIcon(room.icon),
                title: 'Phòng chưa có thiết bị',
                description: 'Chọn các thiết bị đặt ở ${room.name} để theo dõi và điều khiển theo phòng.',
                actionText: 'Thêm thiết bị',
                onActionTap: () => showRoomDevicesSheet(context, room),
              ),
            )
          else
            SliverGrid(
              gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
                maxCrossAxisExtent: 288,
                mainAxisSpacing: AppSpacing.md,
                crossAxisSpacing: AppSpacing.md,
                mainAxisExtent: 230,
              ),
              delegate: SliverChildBuilderDelegate(
                (context, index) {
                  final device = inRoom[index];
                  return productUiRegistry.buildMiniCard(
                    context,
                    device: device,
                    onTap: () => context.push('/device/${device.mac}'),
                    onCapabilityChanged: (capability, value) =>
                        applyCapabilityChange(context, ref, device, capability, value),
                  );
                },
                childCount: inRoom.length,
              ),
            ),
          const SliverToBoxAdapter(child: SizedBox(height: 120)),
        ],
      ),
    );
  }
}

class _RoomHeader extends StatelessWidget {
  const _RoomHeader({required this.room, required this.summary});

  final Room room;
  final RoomSummary summary;

  @override
  Widget build(BuildContext context) {
    final scheme = context.colorScheme;
    final alert = summary.alerts > 0;
    return NeuCard(
      padding: const EdgeInsets.all(AppSpacing.md),
      glowColor: alert ? scheme.error : null,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          NeuIconBox(
            icon: roomIcon(room.icon),
            size: 56,
            iconSize: 28,
            isActive: summary.online > 0,
            activeIconColor: alert ? scheme.error : scheme.primary,
          ),
          const SizedBox(width: AppSpacing.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  summary.total == 0 ? 'Chưa có thiết bị' : '${summary.online}/${summary.total} thiết bị trực tuyến',
                  style: context.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700),
                ),
                const SizedBox(height: AppSpacing.xs),
                Text(
                  alert
                      ? 'Có ${summary.alerts} thiết bị cần bạn kiểm tra'
                      : summary.total == 0
                          ? 'Thêm thiết bị để xem trạng thái phòng'
                          : 'Mọi thứ trong phòng đang ổn',
                  style: context.textTheme.bodySmall?.copyWith(
                    color: alert ? scheme.error : scheme.onSurfaceVariant,
                    fontWeight: alert ? FontWeight.w700 : null,
                  ),
                ),
                if (summary.readings.isNotEmpty) ...[
                  const SizedBox(height: AppSpacing.sm),
                  RoomReadingPills(readings: summary.readings, max: 6),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}
