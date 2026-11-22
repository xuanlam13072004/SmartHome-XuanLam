import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons/lucide_icons.dart';

import '../../../core/core.dart';
import '../../../core/navigation/app_routes.dart';
import '../../../core/theme/theme_mode_controller.dart';
import '../../../core/utils/app_error_mapper.dart';
import '../../../core/widgets/widgets.dart';
import '../../auth/providers/auth_provider.dart';
import '../../notifications/providers/notification_providers.dart';
import '../providers/account_providers.dart';
import '../widgets/profile_header.dart';
import '../widgets/profile_section.dart';
import 'change_password_sheet.dart';
import 'edit_profile_sheet.dart';
import 'theme_mode_sheet.dart';

/// "Cá nhân": the account header and every account feature, one tap away.
class ProfileScreen extends ConsumerWidget {
  const ProfileScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final overview = ref.watch(accountOverviewProvider);
    final themeMode = ref.watch(themeModeProvider);
    final unread = ref.watch(badgesProvider).valueOrNull?.notifications ?? 0;

    return PageScaffold(
      scrollable: false,
      appBar: AppBar(title: const Text('Cá nhân')),
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
      child: RefreshIndicator(
        onRefresh: () async {
          ref.invalidate(accountOverviewProvider);
          try {
            await ref.read(accountOverviewProvider.future);
          } catch (_) {
            // The header shows the error with a retry button.
          }
        },
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.only(top: AppSpacing.sm, bottom: 120),
          children: [
            overview.when(
              data: (data) => ProfileHeader(
                overview: data,
                onEdit: () => showEditProfileSheet(context, currentName: data.user.fullName),
              ),
              loading: () => const NeuCard(
                child: SizedBox(height: 168, child: Center(child: CircularProgressIndicator())),
              ),
              error: (error, _) => NeuCard(
                child: EmptyState(
                  icon: LucideIcons.alertTriangle,
                  title: 'Không tải được hồ sơ',
                  description: AppErrorMapper.mapError(error),
                  actionText: 'Thử lại',
                  onActionTap: () => ref.invalidate(accountOverviewProvider),
                ),
              ),
            ),
            const SizedBox(height: AppSpacing.lg),
            ProfileSection(
              title: 'Chia sẻ',
              children: [
                ProfileTile(
                  icon: LucideIcons.users,
                  title: 'Chia sẻ thiết bị',
                  subtitle: 'Lời mời, thiết bị được chia sẻ, người dùng chung',
                  badgeCount: overview.valueOrNull?.stats.pendingInvites ?? 0,
                  onTap: () => context.push(AppRoutes.profileSharing),
                ),
              ],
            ),
            ProfileSection(
              title: 'Thông báo & hoạt động',
              children: [
                ProfileTile(
                  icon: LucideIcons.bell,
                  title: 'Thông báo',
                  subtitle: 'Cảnh báo từ thiết bị: khói, khí gas, sai mã PIN, trời mưa…',
                  badgeCount: unread,
                  onTap: () => context.push(AppRoutes.profileNotifications),
                ),
                ProfileTile(
                  icon: LucideIcons.settings2,
                  title: 'Loại thông báo',
                  subtitle: 'Chọn loại cảnh báo muốn nhận',
                  onTap: () => context.push(AppRoutes.profileNotificationSettings),
                ),
                ProfileTile(
                  icon: LucideIcons.history,
                  title: 'Lịch sử hoạt động',
                  subtitle: 'Thao tác của bạn với thiết bị và tài khoản',
                  onTap: () => context.push(AppRoutes.profileActivity),
                ),
              ],
            ),
            ProfileSection(
              title: 'Trợ lý',
              children: [
                ProfileTile(
                  icon: LucideIcons.sparkles,
                  title: 'Trợ lý nhà',
                  subtitle: 'Hỏi đáp và điều khiển thiết bị bằng lời nói hoặc tin nhắn',
                  onTap: () => context.push(AppRoutes.assistant),
                ),
                ProfileTile(
                  icon: LucideIcons.crown,
                  title: 'Gói dịch vụ',
                  subtitle: 'Hạn mức trợ lý mỗi tháng',
                  onTap: () => context.push(AppRoutes.profilePlans),
                ),
              ],
            ),
            ProfileSection(
              title: 'Cài đặt ứng dụng',
              children: [
                ProfileTile(
                  icon: LucideIcons.sunMoon,
                  title: 'Giao diện',
                  value: themeMode.label,
                  onTap: () => showThemeModeSheet(context),
                ),
              ],
            ),
            ProfileSection(
              title: 'Hỗ trợ',
              children: [
                ProfileTile(
                  icon: LucideIcons.lifeBuoy,
                  title: 'Hướng dẫn & trợ giúp',
                  subtitle: 'Cách dùng, câu hỏi thường gặp, trạng thái hệ thống',
                  onTap: () => context.push(AppRoutes.profileHelp),
                ),
              ],
            ),
            ProfileSection(
              title: 'Tài khoản & bảo mật',
              children: [
                ProfileTile(
                  icon: LucideIcons.keyRound,
                  title: 'Đổi mật khẩu',
                  subtitle: 'Các thiết bị khác sẽ bị đăng xuất',
                  onTap: () => showChangePasswordSheet(context),
                ),
                ProfileTile(
                  icon: LucideIcons.fingerprint,
                  title: 'Giọng nói',
                  subtitle: 'Đăng ký để hệ thống nhận ra đúng giọng của bạn',
                  onTap: () => context.push(AppRoutes.profileVoice),
                ),
                ProfileTile(
                  icon: LucideIcons.smartphone,
                  title: 'Phiên đăng nhập',
                  subtitle: 'Xem và đăng xuất các thiết bị đang đăng nhập',
                  onTap: () => context.push(AppRoutes.profileSessions),
                ),
                ProfileTile(
                  icon: LucideIcons.logOut,
                  title: 'Đăng xuất',
                  destructive: true,
                  onTap: () => _confirmSignOut(context, ref),
                ),
                ProfileTile(
                  icon: LucideIcons.userX,
                  title: 'Xóa tài khoản',
                  destructive: true,
                  onTap: () => context.push(AppRoutes.profileDeleteAccount),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _confirmSignOut(BuildContext context, WidgetRef ref) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Đăng xuất?'),
        content: const Text('Bạn sẽ cần đăng nhập lại để xem và điều khiển thiết bị.'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('Hủy'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('Đăng xuất'),
          ),
        ],
      ),
    );
    if (confirmed == true) await ref.read(authControllerProvider.notifier).logout();
  }
}
