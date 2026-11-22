import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/navigation/app_routes.dart';
import '../../../domain/models/ws_events.dart';
import '../../dashboard/providers/devices_provider.dart';
import '../../dashboard/providers/realtime_provider.dart';
import '../../notifications/notification_labels.dart';
import '../../notifications/providers/notification_providers.dart';
import '../../sharing/providers/sharing_providers.dart';
import '../../voice/providers/voice_providers.dart';
import '../../assistant/providers/assistant_providers.dart';
import '../../payments/providers/payments_providers.dart';
import '../providers/account_providers.dart';

/// Reacts to realtime events anywhere in the app: device warnings and alarms
/// (unless their category is muted), messages from the account's automations,
/// sharing invitations, and the badges of the "Cá nhân" tab.
class AccountEventListener extends ConsumerStatefulWidget {
  const AccountEventListener({super.key, required this.child});

  final Widget child;

  @override
  ConsumerState<AccountEventListener> createState() => _AccountEventListenerState();
}

class _AccountEventListenerState extends ConsumerState<AccountEventListener> {
  StreamSubscription<WsEvent>? _subscription;

  @override
  void initState() {
    super.initState();
    _subscription = ref.read(realtimeRepositoryProvider).eventStream.listen(_onEvent);
  }

  @override
  void dispose() {
    _subscription?.cancel();
    super.dispose();
  }

  void _onEvent(WsEvent event) {
    if (!mounted) return;
    switch (event) {
      case final DeviceEventEvent deviceEvent:
        _onDeviceEvent(deviceEvent);
      case final DeviceAccessEvent access:
        _refreshAccount();
        if (!access.granted) _show('Một thiết bị được chia sẻ với bạn đã bị thu hồi');
      case final AccountNotificationEvent notice when notice.event == 'payment_updated':
        ref
          ..invalidate(paymentOrdersProvider)
          ..invalidate(assistantUsageProvider);
        final order = notice.data['order'] is Map
            ? Map<String, dynamic>.from(notice.data['order'] as Map)
            : const <String, dynamic>{};
        final plan = order['plan'] is Map ? (order['plan'] as Map)['name']?.toString() : null;
        if (order['status'] == 'paid') {
          _show('Đã kích hoạt gói ${plan ?? 'trợ lý'}', route: AppRoutes.profilePlans);
        }
      case final AccountNotificationEvent notice when notice.event == 'notification_created':
        ref.invalidate(badgesProvider);
        final item = notice.data['notification'] is Map
            ? Map<String, dynamic>.from(notice.data['notification'] as Map)
            : const <String, dynamic>{};
        final body = item['body']?.toString() ?? '';
        if (item['kind'] == 'security') {
          ref.invalidate(voiceStateProvider);
          _show(body.isEmpty ? 'Có cảnh báo bảo mật mới' : body, route: AppRoutes.profileVoice);
        } else {
          _show(body.isEmpty ? 'Tự động hóa vừa gửi thông báo' : body, route: AppRoutes.profileNotifications);
        }
      case final AccountNotificationEvent notice:
        _refreshAccount();
        final device = notice.data['device_name']?.toString() ?? 'thiết bị';
        if (notice.event == 'sharing_invite_received') {
          final owner = notice.data['owner_name']?.toString() ?? 'Ai đó';
          _show('$owner mời bạn dùng chung "$device"', route: AppRoutes.profileSharing);
        } else if (notice.event == 'sharing_member_joined') {
          final member = notice.data['member_name']?.toString() ?? 'Một người';
          _show('$member đã chấp nhận lời mời dùng "$device"');
        }
      default:
        break;
    }
  }

  void _refreshAccount() {
    ref.invalidate(accountOverviewProvider);
    ref.invalidate(sharingOverviewProvider);
    ref.invalidate(badgesProvider);
  }

  void _onDeviceEvent(DeviceEventEvent event) {
    final severity = event.payload['severity']?.toString();
    if (severity != 'warning' && severity != 'critical') return;
    ref.invalidate(badgesProvider);
    final category = event.payload['category']?.toString() ?? 'device';
    final muted = ref.read(mutedCategoriesProvider).valueOrNull ?? const <String>{};
    if (category != 'safety' && muted.contains(category)) return;

    final devices = ref.read(devicesProvider).valueOrNull ?? const [];
    final deviceName = devices.where((d) => d.mac == event.mac).map((d) => d.name).firstOrNull ?? 'Thiết bị';
    final data = event.payload['data'] is Map
        ? Map<String, dynamic>.from(event.payload['data'] as Map)
        : <String, dynamic>{};
    final title = NotificationLabels.eventTitle(event.payload['event_name']?.toString() ?? '', data);
    _show('$deviceName: $title', route: AppRoutes.profileNotifications, critical: severity == 'critical');
  }

  void _show(String message, {String? route, bool critical = false}) {
    final scheme = Theme.of(context).colorScheme;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(message, style: critical ? TextStyle(color: scheme.onError) : null),
      backgroundColor: critical ? scheme.error : null,
      duration: Duration(seconds: critical ? 10 : 4),
      action: route == null
          ? null
          : SnackBarAction(
              label: 'Xem',
              textColor: critical ? scheme.onError : null,
              onPressed: () => context.push(route),
            ),
    ));
  }

  @override
  Widget build(BuildContext context) {
    // Keep the muted categories loaded so live alerts can respect them.
    ref.watch(mutedCategoriesProvider);
    return widget.child;
  }
}
