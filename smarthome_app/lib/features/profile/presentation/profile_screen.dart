import 'package:flutter/material.dart';
import 'package:lucide_icons/lucide_icons.dart';
import '../../../core/core.dart';
import '../../../core/widgets/widgets.dart';

class ProfileScreen extends StatelessWidget {
  const ProfileScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return PageScaffold(
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
            child: Text(
              'Xuân Lâm',
              style: context.textTheme.headlineSmall?.copyWith(
                fontWeight: FontWeight.bold,
              ),
            ),
          ),
          const SizedBox(height: AppSpacing.xs),
          Center(
            child: Text(
              'xuanlam@example.com',
              style: context.textTheme.bodyMedium?.copyWith(
                color: context.colorScheme.onSurfaceVariant,
              ),
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
                    value: false, // Static value
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
                  onTap: () {},
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
      indent: AppSpacing.lg + 24 + AppSpacing.md, // Canh lề theo text
      color: context.colorScheme.outlineVariant.withValues(alpha: 0.5),
    );
  }
}
