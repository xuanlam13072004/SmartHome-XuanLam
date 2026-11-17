import 'package:flutter/widgets.dart';
import 'package:lucide_icons/lucide_icons.dart';

/// Vietnamese names for sharing roles and permission scopes.
abstract final class SharingLabels {
  static String role(String role) => switch (role) {
        'owner' => 'Chủ sở hữu',
        'controller' => 'Điều khiển',
        'viewer' => 'Chỉ xem',
        _ => role,
      };

  static String roleDescription(String role) => switch (role) {
        'controller' => 'Xem và điều khiển thiết bị',
        'viewer' => 'Chỉ xem trạng thái, không điều khiển',
        _ => '',
      };

  static IconData roleIcon(String role) => switch (role) {
        'controller' => LucideIcons.slidersHorizontal,
        _ => LucideIcons.eye,
      };

  static String permission(String scope) => switch (scope) {
        'device.view' => 'Xem trạng thái thiết bị',
        'camera.view' => 'Xem camera trực tiếp và xem lại',
        'door.control' => 'Khóa / mở cửa',
        'display.write' => 'Đổi nội dung màn hình',
        'cover.control' => 'Đóng / mở mái che',
        'irrigation.control' => 'Bật / tắt tưới cây',
        'alarm.acknowledge' => 'Tắt còi, xác nhận cảnh báo',
        'automation.manage' => 'Đổi lịch và chế độ tự động',
        _ => scope,
      };
}
