import 'package:flutter/material.dart';
import '../../core.dart';
import '../primitives/neu_card.dart';
import '../primitives/neu_icon_box.dart';
import '../indicators/status_badge.dart';

/// Thẻ thiết bị tổng hợp (Presentational component).
/// Không chứa logic lấy dữ liệu, chỉ nhận data qua parameters.
class DeviceCard extends StatelessWidget {
  const DeviceCard({
    super.key,
    required this.title,
    required this.subtitle,
    required this.icon,
    required this.status,
    this.iconColor,
    this.actionWidget,
    this.onTap,
  });

  final String title;
  final String subtitle;
  final IconData icon;
  final DeviceStatus status;
  final Color? iconColor;
  
  /// Widget tương tác nhanh (thường là NeuToggle)
  final Widget? actionWidget;
  
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final isOffline = status == DeviceStatus.offline;

    return GestureDetector(
      onTap: isOffline ? null : onTap,
      behavior: HitTestBehavior.opaque,
      child: AnimatedOpacity(
        duration: const Duration(milliseconds: 200),
        opacity: isOffline ? 0.6 : 1.0,
        child: NeuCard(
          padding: const EdgeInsets.all(AppSpacing.md),
          child: Row(
            children: [
              // ── Khung Icon ───────────────────────────────────────────────────
              NeuIconBox(
                icon: icon,
                size: 48,
                iconSize: 24,
                iconColor: iconColor,
                isActive: status == DeviceStatus.online,
                activeIconColor: iconColor,
              ),
              const SizedBox(width: AppSpacing.md),
              
              // ── Thông tin Text ───────────────────────────────────────────────
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      title,
                      style: context.textTheme.titleMedium,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    const SizedBox(height: 2),
                    Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        StatusBadge(status: status, size: 8),
                        const SizedBox(width: AppSpacing.sm),
                        Expanded(
                          child: Text(
                            subtitle,
                            style: context.textTheme.bodySmall,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
              
              // ── Action (Toggle/Button) ───────────────────────────────────────
              if (actionWidget != null) ...[
                const SizedBox(width: AppSpacing.md),
                actionWidget!,
              ],
            ],
          ),
        ),
      ),
    );
  }
}
