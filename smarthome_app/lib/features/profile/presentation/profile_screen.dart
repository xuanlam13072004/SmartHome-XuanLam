import 'package:flutter/material.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/core.dart';
import '../../../core/widgets/widgets.dart';
import '../../auth/providers/auth_provider.dart';
import '../../../core/storage/token_storage_provider.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

part 'profile_screen.g.dart';

/// Provider to load user profile from secure storage.
@riverpod
Future<Map<String, String>> userProfile(Ref ref) async {
  final storage = ref.watch(tokenStorageProvider);
  final fullName = await storage.getUserFullName() ?? '';
  final email = await storage.getUserEmail() ?? '';
  final username = await storage.getUserUsername() ?? '';
  return {
    'fullName': fullName,
    'email': email,
    'username': username,
  };
}

class ProfileScreen extends ConsumerWidget {
  const ProfileScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final profileAsync = ref.watch(userProfileProvider);

    return PageScaffold(
      scrollable: false,
      appBar: AppBar(
        title: const Text('Cá nhân'),
        centerTitle: false,
      ),
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
      child: ListView(
        padding: const EdgeInsets.only(top: AppSpacing.md, bottom: 100),
        children: [
          // ── User Profile Header ──────────────────────────────────────────
          Center(
            child: NeuIconBox(
              icon: LucideIcons.user,
              size: 100,
              iconSize: 48,
              shape: BoxShape.circle,
              isActive: true,
              iconColor: context.colorScheme.primary,
            ),
          ),
          const SizedBox(height: AppSpacing.lg),
          Center(
            child: profileAsync.when(
              data: (profile) => Text(
                profile['fullName']!.isNotEmpty ? profile['fullName']! : 'Người dùng',
                style: context.textTheme.headlineSmall?.copyWith(
                  fontWeight: FontWeight.bold,
                ),
              ),
              loading: () => const SizedBox(height: 24, width: 24, child: CircularProgressIndicator(strokeWidth: 2)),
              error: (_, __) => Text(
                'Người dùng',
                style: context.textTheme.headlineSmall?.copyWith(
                  fontWeight: FontWeight.bold,
                ),
              ),
            ),
          ),
          const SizedBox(height: AppSpacing.xs),
          Center(
            child: profileAsync.when(
              data: (profile) => Text(
                profile['email']!.isNotEmpty ? profile['email']! : '',
                style: context.textTheme.bodyMedium?.copyWith(
                  color: context.colorScheme.onSurfaceVariant,
                ),
              ),
              loading: () => const SizedBox.shrink(),
              error: (_, __) => const SizedBox.shrink(),
            ),
          ),
          const SizedBox(height: AppSpacing.xxl),

          // ── Settings List ────────────────────────────────────────────────
          const SectionTitle(title: 'Cài đặt chung'),
          NeuCard(
            padding: EdgeInsets.zero,
            child: Column(
              children: [
                _buildSettingTile(
                  context: context,
                  icon: LucideIcons.moon,
                  title: 'Giao diện tối',
                  trailing: NeuToggle(
                    value: false,
                    onChanged: (_) {},
                  ),
                ),
                _buildDivider(context),
                _buildSettingTile(
                  context: context,
                  icon: LucideIcons.bell,
                  title: 'Thông báo',
                  trailing: NeuToggle(
                    value: true,
                    onChanged: (_) {},
                  ),
                ),
                _buildDivider(context),
                _buildSettingTile(
                  context: context,
                  icon: LucideIcons.globe,
                  title: 'Ngôn ngữ',
                  trailing: const Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text('Tiếng Việt'),
                      SizedBox(width: 8),
                      Icon(LucideIcons.chevronRight, size: 16),
                    ],
                  ),
                  onTap: () {},
                ),
              ],
            ),
          ),
          const SizedBox(height: AppSpacing.xl),
          const SectionTitle(title: 'Khác'),
          NeuCard(
            padding: EdgeInsets.zero,
            child: Column(
              children: [
                _buildSettingTile(
                  context: context,
                  icon: LucideIcons.shieldQuestion,
                  title: 'Hỗ trợ & Trợ giúp',
                  trailing: const Icon(LucideIcons.chevronRight, size: 16),
                  onTap: () {},
                ),
                _buildDivider(context),
                _buildSettingTile(
                  context: context,
                  icon: LucideIcons.logOut,
                  title: 'Đăng xuất',
                  iconColor: context.colorScheme.error,
                  textColor: context.colorScheme.error,
                  onTap: () {
                    ref.read(authControllerProvider.notifier).logout();
                  },
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildSettingTile({
    required BuildContext context,
    required IconData icon,
    required String title,
    Widget? trailing,
    Color? iconColor,
    Color? textColor,
    VoidCallback? onTap,
  }) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(AppRadius.lg),
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.lg,
          vertical: AppSpacing.md,
        ),
        child: Row(
          children: [
            Icon(icon, size: 24, color: iconColor ?? context.colorScheme.onSurface),
            const SizedBox(width: AppSpacing.md),
            Expanded(
              child: Text(
                title,
                style: context.textTheme.bodyLarge?.copyWith(
                  fontWeight: FontWeight.w500,
                  color: textColor ?? context.colorScheme.onSurface,
                ),
              ),
            ),
            if (trailing != null) trailing,
          ],
        ),
      ),
    );
  }

  Widget _buildDivider(BuildContext context) {
    return Divider(
      height: 1,
      thickness: 1,
      indent: AppSpacing.lg + 24 + AppSpacing.md,
      color: context.colorScheme.outlineVariant.withValues(alpha: 0.5),
    );
  }
}
