import 'package:flutter/material.dart';
import '../../../core/core.dart';
import '../../../core/widgets/widgets.dart';
import '../models/room_mock.dart';
import '../widgets/room_card.dart';

class RoomsScreen extends StatelessWidget {
  const RoomsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return PageScaffold(
      appBar: AppBar(
        title: const Text('Phòng'),
        centerTitle: false,
      ),
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
      child: GridView.builder(
        padding: const EdgeInsets.only(top: AppSpacing.md, bottom: 100),
        // Responsive grid
        gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
          maxCrossAxisExtent: 220, // 2 cột cho màn hình đt
          mainAxisSpacing: AppSpacing.md,
          crossAxisSpacing: AppSpacing.md,
          childAspectRatio: 1.1, // Thẻ phòng thường rộng hơn một chút
        ),
        itemCount: RoomMock.staticRooms.length,
        itemBuilder: (context, index) {
          final room = RoomMock.staticRooms[index];
          return RoomCard(
            room: room,
            onTap: () {},
          );
        },
      ),
    );
  }
}
