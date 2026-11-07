import '../../domain/models/device_model.dart';
import '../../domain/models/product_model.dart';
import '../products/product_capability_query.dart';

/// Reads firmware-reported camera properties and turns them into labels.
extension SecurityCameraState on DeviceModel {
  dynamic cameraValue(String propertyId) =>
      capabilityMatching(ids: [propertyId])?.value;

  String get cameraStateLabel => switch ('${cameraValue('camera_state')}') {
        'idle' => 'Sẵn sàng',
        'streaming' => 'Đang phát trực tiếp',
        'unavailable' => 'Chưa có nguồn hình',
        'offline' => 'Ngoại tuyến',
        'fault' => 'Lỗi camera',
        _ => 'Chưa rõ',
      };

  String get recordingStateLabel => switch ('${cameraValue('recording_state')}') {
        'recording' => 'Đang ghi',
        'stopped' => 'Không ghi',
        'waiting_time_sync' => 'Chờ đồng bộ giờ',
        'fault' => 'Lỗi ghi',
        _ => 'Chưa rõ',
      };

  bool get cameraHasImage {
    final state = '${cameraValue('camera_state')}';
    return state == 'idle' || state == 'streaming';
  }

  int get liveViewers => (cameraValue('live_viewers') as num?)?.toInt() ?? 0;

  String get storageSummary {
    final used = (cameraValue('storage_used_bytes') as num?)?.toInt();
    final total = (cameraValue('storage_total_bytes') as num?)?.toInt();
    if (used == null || total == null || total <= 0) return 'Chưa có dữ liệu';
    return '${formatBytes(used)} / ${formatBytes(total)}';
  }

  DeviceResourceDefinition? cameraResource(String resourceId) {
    for (final resource in resources) {
      if (resource.definition.id == resourceId) return resource;
    }
    return null;
  }

  /// Owner, or a member granted `camera.recording.manage`.
  bool get canManageRecordings =>
      membershipRole == 'owner' || permissions.contains('camera.recording.manage');
}

String formatBytes(int bytes) {
  const gb = 1024 * 1024 * 1024;
  const mb = 1024 * 1024;
  if (bytes >= gb) return '${(bytes / gb).toStringAsFixed(1)} GB';
  if (bytes >= mb) return '${(bytes / mb).toStringAsFixed(0)} MB';
  return '${(bytes / 1024).toStringAsFixed(0)} KB';
}

String _two(int value) => value.toString().padLeft(2, '0');

String formatClock(DateTime time) =>
    '${_two(time.hour)}:${_two(time.minute)}:${_two(time.second)}';

String formatShortClock(DateTime time) => '${_two(time.hour)}:${_two(time.minute)}';

String formatDay(DateTime day) {
  final now = DateTime.now();
  final today = DateTime(now.year, now.month, now.day);
  final label = '${_two(day.day)}/${_two(day.month)}/${day.year}';
  if (day == today) return 'Hôm nay, $label';
  if (day == today.subtract(const Duration(days: 1))) return 'Hôm qua, $label';
  return label;
}

String formatDuration(Duration duration) {
  final minutes = duration.inMinutes;
  if (minutes < 1) return '${duration.inSeconds} giây';
  if (minutes < 60) return '$minutes phút';
  return '${minutes ~/ 60} giờ ${minutes % 60} phút';
}
