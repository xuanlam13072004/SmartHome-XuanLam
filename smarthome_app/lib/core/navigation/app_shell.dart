import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons/lucide_icons.dart';

import 'widgets/neu_bottom_bar.dart';
import 'widgets/neu_bottom_item.dart';

/// Khung giao diện chính (App Shell).
/// Quản lý Bottom Navigation và cung cấp Scaffold tổng cho toàn bộ các tab.
class AppShell extends StatelessWidget {
  const AppShell({
    super.key,
    required this.navigationShell,
  });

  final StatefulNavigationShell navigationShell;

  void _onItemTapped(int index) {
    navigationShell.goBranch(
      index,
      // A common pattern when using bottom navigation bars is to support
      // navigating to the initial location when tapping the item that is
      // already active.
      initialLocation: index == navigationShell.currentIndex,
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      // Cho phép các màn hình con có thể thay đổi màu nền hoặc dùng CustomScrollView
      body: navigationShell,
      // Sử dụng `extendBody: true` nếu muốn bottom bar nổi lơ lửng trên nền
      extendBody: true, 
      bottomNavigationBar: NeuBottomBar(
        items: [
          NeuBottomItem(
            icon: LucideIcons.layoutDashboard,
            label: 'Tổng quan',
            isSelected: navigationShell.currentIndex == 0,
            onTap: () => _onItemTapped(0),
          ),
          NeuBottomItem(
            icon: LucideIcons.box,
            label: 'Phòng',
            isSelected: navigationShell.currentIndex == 1,
            onTap: () => _onItemTapped(1),
          ),
          NeuBottomItem(
            icon: LucideIcons.clapperboard, // Hoặc image/layers
            label: 'Kịch bản',
            isSelected: navigationShell.currentIndex == 2,
            onTap: () => _onItemTapped(2),
          ),
          NeuBottomItem(
            icon: LucideIcons.user,
            label: 'Cá nhân',
            isSelected: navigationShell.currentIndex == 3,
            onTap: () => _onItemTapped(3),
          ),
        ],
      ),
    );
  }
}
