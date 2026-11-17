import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/dio_provider.dart';
import '../../../core/utils/app_error_mapper.dart';
import '../data/notification_models.dart';
import '../data/notifications_api.dart';

final notificationsApiProvider = Provider.autoDispose<NotificationsApi>(
  (ref) => NotificationsApi(ref.watch(dioProvider)),
);

/// Unread notifications and pending invitations, shown on the "Cá nhân" tab.
final badgesProvider = FutureProvider.autoDispose<AccountBadges>(
  (ref) => ref.watch(notificationsApiProvider).fetchBadges(),
);

/// Categories the user turned off. Safety alerts are never muted.
final mutedCategoriesProvider = FutureProvider.autoDispose<Set<String>>(
  (ref) => ref.watch(notificationsApiProvider).fetchMutedCategories(),
);

/// A list loaded page by page with a server cursor.
class PagedList<T> {
  const PagedList({required this.items, this.nextCursor, this.loadingMore = false, this.error});

  final List<T> items;
  final String? nextCursor;
  final bool loadingMore;
  final String? error;

  bool get hasMore => nextCursor != null;
}

abstract class PagedNotifier<T> extends AutoDisposeAsyncNotifier<PagedList<T>> {
  Future<CursorPage<T>> fetch(String? before);

  @override
  Future<PagedList<T>> build() async {
    final page = await fetch(null);
    return PagedList(items: page.items, nextCursor: page.nextCursor);
  }

  Future<void> loadMore() async {
    final current = state.valueOrNull;
    if (current == null || !current.hasMore || current.loadingMore) return;
    state = AsyncData(PagedList(items: current.items, nextCursor: current.nextCursor, loadingMore: true));
    try {
      final page = await fetch(current.nextCursor);
      state = AsyncData(PagedList(items: [...current.items, ...page.items], nextCursor: page.nextCursor));
    } catch (error) {
      state = AsyncData(PagedList(
        items: current.items,
        nextCursor: current.nextCursor,
        error: AppErrorMapper.mapError(error),
      ));
    }
  }
}

/// "Thông báo" (the screen marks everything read once the first page shows).
class NotificationsNotifier extends PagedNotifier<AppNotification> {
  @override
  Future<CursorPage<AppNotification>> fetch(String? before) =>
      ref.read(notificationsApiProvider).fetchNotifications(before: before);
}

final notificationsProvider =
    AsyncNotifierProvider.autoDispose<NotificationsNotifier, PagedList<AppNotification>>(NotificationsNotifier.new);

/// "Lịch sử hoạt động".
class ActivityNotifier extends PagedNotifier<ActivityItem> {
  @override
  Future<CursorPage<ActivityItem>> fetch(String? before) =>
      ref.read(notificationsApiProvider).fetchActivity(before: before);
}

final activityProvider =
    AsyncNotifierProvider.autoDispose<ActivityNotifier, PagedList<ActivityItem>>(ActivityNotifier.new);
