import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons/lucide_icons.dart';

import '../../../core/core.dart';
import '../../../core/navigation/app_routes.dart';
import '../../../core/utils/app_error_mapper.dart';
import '../../../core/widgets/widgets.dart';
import '../../../domain/models/device_model.dart';
import '../../dashboard/providers/devices_provider.dart';
import '../data/room_models.dart';
import '../providers/rooms_providers.dart';
import '../room_icons.dart';
import '../room_insights.dart';
import '../widgets/room_card.dart';
import 'room_actions.dart';
import 'room_devices_sheet.dart';
import 'room_editor_sheet.dart';
import 'room_picker_sheet.dart';
import 'room_setup_sheet.dart';

/// "Phòng": the account's own rooms with their live state, plus the devices
/// not yet in a room.
class RoomsScreen extends ConsumerWidget {
  const RoomsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final roomsAsync = ref.watch(roomsProvider);
    final devices = ref.watch(devicesProvider).valueOrNull ?? const <DeviceModel>[];
    final list = roomsAsync.valueOrNull;
    final groups = RoomGroups(list?.rooms ?? const [], devices);
    final suggestions = list == null ? const <RoomDraft>[] : suggestRooms(groups.unassigned, list.rooms);

    return PageScaffold(
      scrollable: false,
      appBar: AppBar(
        title: const Text('Phòng'),
        centerTitle: false,
        actions: [
          if (list != null) ...[
            IconButton(
              tooltip: 'Thêm phòng',
              icon: const Icon(Icons.add_rounded),
              onPressed: () => createRoom(context, ref),
            ),
            if (list.rooms.length > 1 || suggestions.isNotEmpty)
              PopupMenuButton<String>(
                onSelected: (value) {
                  if (value == 'order') {
                    showReorderSheet<Room>(
                      context,
                      title: 'Sắp xếp phòng',
                      items: list.rooms,
                      idOf: (room) => room.id,
                      labelOf: (room) => room.name,
                      iconOf: (room) => roomIcon(room.icon),
                      onSave: ref.read(roomsProvider.notifier).reorder,
                    );
                  }
                  if (value == 'suggest') showRoomSetupSheet(context, suggestions);
                },
                itemBuilder: (context) => [
                  if (list.rooms.length > 1)
                    const PopupMenuItem(
                      value: 'order',
                      child: ListTile(leading: Icon(Icons.swap_vert_rounded), title: Text('Sắp xếp phòng')),
                    ),
                  if (suggestions.isNotEmpty)
                    const PopupMenuItem(
                      value: 'suggest',
                      child: ListTile(leading: Icon(Icons.auto_awesome_rounded), title: Text('Gợi ý xếp phòng')),
                    ),
                ],
              ),
          ],
        ],
      ),
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
      child: roomsAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, _) => EmptyState(
          icon: LucideIcons.alertTriangle,
          title: 'Không tải được danh sách phòng',
          description: AppErrorMapper.mapError(error),
          actionText: 'Thử lại',
          onActionTap: () => ref.invalidate(roomsProvider),
        ),
        data: (list) => RefreshIndicator(
          onRefresh: () async {
            ref.invalidate(roomsProvider);
            ref.invalidate(devicesProvider);
            try {
              await ref.read(roomsProvider.future);
            } catch (_) {}
          },
          child: CustomScrollView(
            physics: const AlwaysScrollableScrollPhysics(),
            slivers: [
              const SliverToBoxAdapter(child: SizedBox(height: AppSpacing.sm)),
              if (list.rooms.isEmpty && suggestions.isNotEmpty)
                SliverToBoxAdapter(
                  child: _SuggestionBanner(
                    deviceCount: suggestions.fold(0, (sum, draft) => sum + draft.macs.length),
                    names: suggestions.map((draft) => draft.name).toList(),
                    onReview: () => showRoomSetupSheet(context, suggestions),
                    onCreate: () => showRoomEditor(context),
                  ),
                ),
              if (list.rooms.isEmpty && suggestions.isEmpty)
                SliverFillRemaining(
                  hasScrollBody: false,
                  child: Center(
                    child: EmptyState(
                      icon: Icons.meeting_room_rounded,
                      title: 'Chưa có phòng nào',
                      description: 'Tạo phòng để nhóm thiết bị theo từng khu vực trong nhà và điều khiển nhanh theo phòng.',
                      actionText: 'Tạo phòng',
                      onActionTap: () => showRoomEditor(context),
                    ),
                  ),
                ),
              if (list.rooms.isNotEmpty)
                SliverGrid(
                  gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
                    maxCrossAxisExtent: 240,
                    mainAxisSpacing: AppSpacing.md,
                    crossAxisSpacing: AppSpacing.md,
                    mainAxisExtent: 186,
                  ),
                  delegate: SliverChildBuilderDelegate(
                    (context, index) {
                      final room = list.rooms[index];
                      return RoomCard(
                        icon: roomIcon(room.icon),
                        name: room.name,
                        summary: summarizeRoom(groups.of(room.id)),
                        onTap: () => context.push(AppRoutes.roomDetailOf(room.id)),
                        menu: _RoomMenu(room: room),
                      );
                    },
                    childCount: list.rooms.length,
                  ),
                ),
              if (groups.unassigned.isNotEmpty && list.rooms.isNotEmpty) ...[
                SliverToBoxAdapter(
                  child: Padding(
                    padding: const EdgeInsets.only(top: AppSpacing.lg),
                    child: SectionTitle(title: 'Chưa xếp phòng (${groups.unassigned.length})'),
                  ),
                ),
                SliverList.separated(
                  itemCount: groups.unassigned.length,
                  separatorBuilder: (_, __) => const SizedBox(height: AppSpacing.sm),
                  itemBuilder: (context, index) => _UnassignedDevice(device: groups.unassigned[index]),
                ),
              ],
              const SliverToBoxAdapter(child: SizedBox(height: 120)),
            ],
          ),
        ),
      ),
    );
  }
}

class _RoomMenu extends ConsumerWidget {
  const _RoomMenu({required this.room});

  final Room room;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return SizedBox.square(
      dimension: 32,
      child: PopupMenuButton<String>(
        padding: EdgeInsets.zero,
        tooltip: 'Tùy chọn phòng',
        icon: Icon(Icons.more_vert, size: 20, color: context.colorScheme.onSurfaceVariant),
        onSelected: (value) {
          switch (value) {
            case 'edit':
              showRoomEditor(context, room: room);
            case 'devices':
              showRoomDevicesSheet(context, room);
            case 'delete':
              deleteRoom(context, ref, room);
          }
        },
        itemBuilder: (context) => [
          const PopupMenuItem(
            value: 'edit',
            child: ListTile(leading: Icon(Icons.edit_rounded), title: Text('Đổi tên, biểu tượng')),
          ),
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
    );
  }
}

class _SuggestionBanner extends StatelessWidget {
  const _SuggestionBanner({
    required this.deviceCount,
    required this.names,
    required this.onReview,
    required this.onCreate,
  });

  final int deviceCount;
  final List<String> names;
  final VoidCallback onReview;
  final VoidCallback onCreate;

  @override
  Widget build(BuildContext context) {
    final scheme = context.colorScheme;
    return NeuCard(
      padding: const EdgeInsets.all(AppSpacing.md),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.auto_awesome_rounded, color: scheme.primary),
              const SizedBox(width: AppSpacing.sm),
              Expanded(
                child: Text(
                  'Xếp phòng nhanh',
                  style: context.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700),
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.sm),
          Text(
            'Bạn có $deviceCount thiết bị chưa thuộc phòng nào. Có thể tạo ngay: ${names.join(', ')}.',
            style: context.textTheme.bodyMedium?.copyWith(color: scheme.onSurfaceVariant),
          ),
          const SizedBox(height: AppSpacing.md),
          Wrap(
            spacing: AppSpacing.sm,
            runSpacing: AppSpacing.sm,
            children: [
              FilledButton.icon(
                onPressed: onReview,
                icon: const Icon(Icons.auto_awesome_rounded, size: 18),
                label: const Text('Xem gợi ý'),
              ),
              OutlinedButton.icon(
                onPressed: onCreate,
                icon: const Icon(Icons.add_rounded, size: 18),
                label: const Text('Tự tạo phòng'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _UnassignedDevice extends ConsumerWidget {
  const _UnassignedDevice({required this.device});

  final DeviceModel device;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final online = device.status == DeviceStatus.online;
    return NeuCard(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm, vertical: AppSpacing.xs),
      child: ListTile(
        contentPadding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm),
        leading: Icon(device.icon, color: online ? context.colorScheme.primary : context.colorScheme.onSurfaceVariant),
        title: Text(device.name, maxLines: 1, overflow: TextOverflow.ellipsis),
        subtitle: Text(online ? 'Trực tuyến' : 'Ngoại tuyến'),
        trailing: TextButton(
          onPressed: () => moveDeviceToRoom(context, ref, device),
          child: const Text('Xếp phòng'),
        ),
        onTap: () => context.push('/device/${device.mac}'),
      ),
    );
  }
}
