import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/core.dart';
import '../../../core/widgets/widgets.dart';
import '../providers/rooms_provider.dart';
import '../widgets/room_card.dart';

class RoomsScreen extends ConsumerWidget {
  const RoomsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final roomsAsync = ref.watch(roomsProvider);

    return PageScaffold(
      appBar: AppBar(
        title: const Text('Phòng'),
        centerTitle: false,
      ),
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
      child: roomsAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (err, stack) => Center(child: Text('Lỗi: $err')),
        data: (rooms) => GridView.builder(
          padding: const EdgeInsets.only(top: AppSpacing.md, bottom: 100),
          gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
            maxCrossAxisExtent: 220,
            mainAxisSpacing: AppSpacing.md,
            crossAxisSpacing: AppSpacing.md,
            childAspectRatio: 1.1,
          ),
          itemCount: rooms.length,
          itemBuilder: (context, index) {
            final room = rooms[index];
            return RoomCard(
              room: room,
              onTap: () {},
            );
          },
        ),
      ),
    );
  }
}

