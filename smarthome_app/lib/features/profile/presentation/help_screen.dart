import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons/lucide_icons.dart';

import '../../../core/config/app_config.dart';
import '../../../core/core.dart';
import '../../../core/network/websocket_client.dart';
import '../../../core/widgets/widgets.dart';
import '../../dashboard/providers/realtime_provider.dart';
import '../providers/account_providers.dart';
import 'help_topics.dart';

/// "Hướng dẫn & trợ giúp": how-to guides, FAQ, live system status and version.
class HelpScreen extends ConsumerWidget {
  const HelpScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return PageScaffold(
      scrollable: false,
      appBar: AppBar(title: const Text('Hướng dẫn & trợ giúp')),
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
      child: ListView(
        padding: const EdgeInsets.only(top: AppSpacing.sm, bottom: 120),
        children: [
          const SectionTitle(title: 'Trạng thái hệ thống'),
          const _SystemStatusCard(),
          const SizedBox(height: AppSpacing.lg),
          const SectionTitle(title: 'Hướng dẫn'),
          for (final topic in helpGuides) _TopicCard(topic: topic),
          const SizedBox(height: AppSpacing.lg),
          const SectionTitle(title: 'Câu hỏi thường gặp'),
          for (final topic in helpFaq) _TopicCard(topic: topic),
          const SizedBox(height: AppSpacing.lg),
          const SectionTitle(title: 'Giới thiệu'),
          NeuCard(
            child: Row(
              children: [
                Icon(LucideIcons.home, color: context.colorScheme.primary),
                const SizedBox(width: AppSpacing.md),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('SmartHome XuanLam', style: context.textTheme.titleMedium),
                      Text(
                        'Phiên bản ${AppConfig.appVersion}',
                        style: context.textTheme.bodySmall?.copyWith(
                          color: context.colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _TopicCard extends StatelessWidget {
  const _TopicCard({required this.topic});

  final HelpTopic topic;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.smMd),
      child: NeuCard(
        padding: EdgeInsets.zero,
        child: Theme(
          // ExpansionTile draws borders when open; the card already frames it.
          data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
          child: ExpansionTile(
            leading: Icon(topic.icon, color: context.colorScheme.primary),
            title: Text(topic.title, style: context.textTheme.titleSmall),
            childrenPadding: const EdgeInsets.fromLTRB(
              AppSpacing.lg,
              0,
              AppSpacing.lg,
              AppSpacing.md,
            ),
            expandedCrossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (var i = 0; i < topic.steps.length; i++)
                Padding(
                  padding: const EdgeInsets.only(bottom: AppSpacing.sm),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      SizedBox(
                        width: 22,
                        child: Text(
                          topic.numbered ? '${i + 1}.' : '•',
                          style: context.textTheme.bodyMedium?.copyWith(
                            color: context.colorScheme.primary,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                      Expanded(child: Text(topic.steps[i], style: context.textTheme.bodyMedium)),
                    ],
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _SystemStatusCard extends ConsumerWidget {
  const _SystemStatusCard();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final server = ref.watch(serverReachableProvider);
    final realtime = ref.watch(connectionStatusProvider).valueOrNull ??
        ref.watch(webSocketClientProvider).currentStatus;

    final (serverState, serverLabel) = server.when(
      data: (ok) => ok ? (_State.good, 'Đang hoạt động') : (_State.bad, 'Không kết nối được'),
      loading: () => (_State.pending, 'Đang kiểm tra…'),
      error: (_, __) => (_State.bad, 'Không kết nối được'),
    );
    final (realtimeState, realtimeLabel) = switch (realtime) {
      ConnectionStatus.connected => (_State.good, 'Đã kết nối'),
      ConnectionStatus.connecting ||
      ConnectionStatus.authenticating ||
      ConnectionStatus.reconnecting =>
        (_State.pending, 'Đang kết nối…'),
      ConnectionStatus.disconnected => (_State.bad, 'Chưa kết nối'),
      ConnectionStatus.error => (_State.bad, 'Lỗi kết nối'),
    };

    return NeuCard(
      child: Column(
        children: [
          _StatusRow(
            icon: LucideIcons.server,
            title: 'Máy chủ',
            state: serverState,
            label: serverLabel,
          ),
          const SizedBox(height: AppSpacing.smMd),
          _StatusRow(
            icon: LucideIcons.activity,
            title: 'Cập nhật thời gian thực',
            state: realtimeState,
            label: realtimeLabel,
          ),
          const SizedBox(height: AppSpacing.sm),
          Align(
            alignment: Alignment.centerRight,
            child: TextButton.icon(
              onPressed: () => ref.invalidate(serverReachableProvider),
              icon: const Icon(LucideIcons.refreshCw, size: 16),
              label: const Text('Kiểm tra lại'),
            ),
          ),
        ],
      ),
    );
  }
}

enum _State { good, pending, bad }

class _StatusRow extends StatelessWidget {
  const _StatusRow({
    required this.icon,
    required this.title,
    required this.state,
    required this.label,
  });

  final IconData icon;
  final String title;
  final _State state;
  final String label;

  @override
  Widget build(BuildContext context) {
    final color = switch (state) {
      _State.good => const Color(0xFF2E9E5B),
      _State.pending => context.colorScheme.onSurfaceVariant,
      _State.bad => context.colorScheme.error,
    };
    return Row(
      children: [
        Icon(icon, size: 20, color: context.colorScheme.onSurfaceVariant),
        const SizedBox(width: AppSpacing.md),
        Expanded(child: Text(title, style: context.textTheme.bodyLarge)),
        Container(
          width: 8,
          height: 8,
          decoration: BoxDecoration(color: color, shape: BoxShape.circle),
        ),
        const SizedBox(width: AppSpacing.sm),
        Text(label, style: context.textTheme.bodyMedium?.copyWith(color: color)),
      ],
    );
  }
}
