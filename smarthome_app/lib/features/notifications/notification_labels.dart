import 'package:flutter/widgets.dart';
import 'package:lucide_icons/lucide_icons.dart';

import '../../core/utils/app_error_mapper.dart';
import '../sharing/sharing_labels.dart';
import 'data/notification_models.dart';

/// A notification category as shown in "Loại thông báo".
class NotificationCategoryInfo {
  const NotificationCategoryInfo(this.id, this.label, this.description, this.icon, {this.locked = false});

  final String id;
  final String label;
  final String description;
  final IconData icon;

  /// Safety alerts cannot be turned off.
  final bool locked;
}

abstract final class NotificationLabels {
  static const categories = <NotificationCategoryInfo>[
    NotificationCategoryInfo('safety', 'An toàn cháy nổ', 'Khói, khí gas, lửa, còi báo động', LucideIcons.flame,
        locked: true),
    NotificationCategoryInfo('security', 'An ninh cửa ra vào', 'Nhập sai mã PIN, bàn phím bị khóa, lỗi cửa',
        LucideIcons.shieldAlert),
    NotificationCategoryInfo('camera', 'Camera', 'Lỗi bộ nhớ ghi hình', LucideIcons.video),
    NotificationCategoryInfo('outdoor', 'Mái che & tưới cây', 'Trời mưa, bể nước cạn, không thể tưới',
        LucideIcons.cloudRain),
    NotificationCategoryInfo('device', 'Thiết bị khác', 'Cảnh báo khác từ thiết bị', LucideIcons.cpu),
  ];

  static NotificationCategoryInfo category(String id) =>
      categories.firstWhere((item) => item.id == id, orElse: () => categories.last);

  /// Title of a warning/critical device event.
  static String eventTitle(String eventName, Map<String, dynamic> data) => switch (eventName) {
        'smoke_threshold_crossed' => 'Khói vượt ngưỡng',
        'gas_threshold_crossed' => 'Khí gas vượt ngưỡng',
        'flame_detected' => 'Phát hiện lửa',
        'incident_started' => switch ('${data['cause']}') {
            'gas' => 'Báo động: rò rỉ khí gas',
            'smoke' => 'Báo động: phát hiện khói',
            'flame' => 'Báo động: phát hiện lửa',
            'sensor_fault' => 'Báo động: cảm biến gặp lỗi',
            _ => 'Báo động an toàn',
          },
        'siren_muted' => 'Còi báo động đã tạm tắt',
        'pin_access_denied' => 'Nhập sai mã PIN',
        'pin_locked_out' => 'Bàn phím tạm khóa do nhập sai nhiều lần',
        'door_position_fault' => 'Không xác định được vị trí cửa',
        'storage_fault' => 'Camera gặp lỗi bộ nhớ',
        'rain_started' => 'Trời bắt đầu mưa',
        'water_availability_changed' => switch ('${data['to']}') {
            'empty' => 'Bể nước đã cạn',
            'low' => 'Bể nước sắp hết',
            _ => 'Mực nước bể thay đổi',
          },
        'watering_rejected' => 'Không thể tưới',
        'automatic_watering_suppressed' => 'Tạm hoãn tưới tự động',
        _ => eventName.replaceAll('_', ' '),
      };

  static String notificationTitle(AppNotification notification) => notification.fromAutomation
      ? notification.body ?? notification.title ?? 'Tự động hóa'
      : eventTitle(notification.eventName, notification.data);
}

/// One line of "Lịch sử hoạt động".
class ActivityText {
  const ActivityText(this.icon, this.title, this.subtitle, {this.failed = false});

  final IconData icon;
  final String title;
  final String subtitle;
  final bool failed;
}

abstract final class ActivityLabels {
  static String _q(Object? value) => '“${value ?? ''}”';

  static ActivityText describe(ActivityItem item) {
    final m = item.metadata;
    final device = item.deviceName ?? m['device_name']?.toString() ?? '';
    if (item.kind == 'operation') {
      final failed = item.status != null && item.status != 'succeeded' && item.status != 'accepted'
          && item.status != 'queued' && item.status != 'dispatched' && item.status != 'executing';
      final reason = item.reasonCode == null ? '' : ' · ${AppErrorMapper.messageForCode(item.reasonCode!)}';
      return ActivityText(
        failed ? LucideIcons.xCircle : LucideIcons.zap,
        item.label ?? item.action.replaceAll('_', ' '),
        failed ? '$device · không thành công$reason' : device,
        failed: failed,
      );
    }
    return switch (item.action) {
      'account.profile_updated' => ActivityText(LucideIcons.user, 'Đổi họ tên', 'Thành ${_q(m['full_name'])}'),
      'account.password_changed' => ActivityText(
          LucideIcons.keyRound,
          'Đổi mật khẩu',
          (m['signed_out_sessions'] as num? ?? 0) > 0
              ? 'Đăng xuất ${m['signed_out_sessions']} thiết bị khác'
              : 'Không có thiết bị khác đang đăng nhập'),
      'account.session_revoked' =>
        ActivityText(LucideIcons.logOut, 'Đăng xuất một thiết bị', '${m['name'] ?? 'Thiết bị không xác định'}'),
      'account.other_sessions_revoked' =>
        ActivityText(LucideIcons.logOut, 'Đăng xuất các thiết bị khác', '${m['count']} thiết bị'),
      'device.claimed' => ActivityText(LucideIcons.plusCircle, 'Thêm thiết bị', _q(device)),
      'device.renamed' => ActivityText(LucideIcons.pencil, 'Đổi tên thiết bị', 'Thành ${_q(device)}'),
      'device.unpaired' => ActivityText(LucideIcons.trash2, 'Gỡ thiết bị', _q(device)),
      'sharing.invite_sent' => ActivityText(LucideIcons.userPlus, 'Mời ${m['email']}',
          '${_q(device)} · ${SharingLabels.role('${m['role']}')}'),
      'sharing.invite_cancelled' => ActivityText(LucideIcons.mailX, 'Hủy lời mời ${m['email']}', _q(device)),
      'sharing.invite_accepted' => ActivityText(LucideIcons.userCheck, 'Nhận chia sẻ thiết bị',
          '${_q(device)} · ${SharingLabels.role('${m['role']}')}'),
      'sharing.invite_declined' => ActivityText(LucideIcons.x, 'Từ chối lời mời', _q(device)),
      'sharing.member_updated' => ActivityText(LucideIcons.userCog, 'Đổi quyền của ${m['email']}',
          '${_q(device)} · ${SharingLabels.role('${m['role']}')}'),
      'sharing.member_removed' =>
        ActivityText(LucideIcons.userMinus, 'Xóa quyền của ${m['full_name'] ?? m['email']}', _q(device)),
      'sharing.left' => ActivityText(LucideIcons.logOut, 'Rời khỏi thiết bị được chia sẻ', _q(device)),
      _ => ActivityText(LucideIcons.activity, item.action, device),
    };
  }
}
