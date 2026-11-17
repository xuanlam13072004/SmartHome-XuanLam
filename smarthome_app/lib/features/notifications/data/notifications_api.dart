import 'package:dio/dio.dart';

import 'notification_models.dart';

class NotificationsApi {
  NotificationsApi(this._dio);

  final Dio _dio;

  Map<String, dynamic> _page(String? before, int limit) => {
        'limit': limit,
        if (before != null) 'before': before,
      };

  Future<CursorPage<AppNotification>> fetchNotifications({String? before, int limit = 30}) async {
    final response = await _dio.get<Map<String, dynamic>>('/me/notifications', queryParameters: _page(before, limit));
    final data = response.data!;
    return CursorPage(
      (data['items'] as List? ?? const [])
          .map((item) => AppNotification.fromJson(item as Map<String, dynamic>))
          .toList(),
      data['next_cursor'] as String?,
    );
  }

  Future<void> markSeen() async {
    await _dio.post<void>('/me/notifications/seen');
  }

  Future<AccountBadges> fetchBadges() async {
    final response = await _dio.get<Map<String, dynamic>>('/me/badges');
    final data = response.data ?? const {};
    return AccountBadges(
      notifications: (data['notifications'] as num?)?.toInt() ?? 0,
      invites: (data['invites'] as num?)?.toInt() ?? 0,
    );
  }

  Future<Set<String>> fetchMutedCategories() async {
    final response = await _dio.get<Map<String, dynamic>>('/me/preferences');
    return (response.data?['muted_notification_categories'] as List? ?? const []).map((e) => e.toString()).toSet();
  }

  Future<Set<String>> updateMutedCategories(Set<String> muted) async {
    final response = await _dio.patch<Map<String, dynamic>>(
      '/me/preferences',
      data: {'muted_notification_categories': muted.toList()..sort()},
    );
    return (response.data?['muted_notification_categories'] as List? ?? const []).map((e) => e.toString()).toSet();
  }

  Future<CursorPage<ActivityItem>> fetchActivity({String? before, int limit = 30}) async {
    final response = await _dio.get<Map<String, dynamic>>('/me/activity', queryParameters: _page(before, limit));
    final data = response.data!;
    return CursorPage(
      (data['items'] as List? ?? const [])
          .map((item) => ActivityItem.fromJson(item as Map<String, dynamic>))
          .toList(),
      data['next_cursor'] as String?,
    );
  }
}
