import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons/lucide_icons.dart';

import '../../../core/core.dart';
import '../../../core/navigation/app_routes.dart';
import '../../../core/utils/app_error_mapper.dart';
import '../../../core/widgets/widgets.dart';
import '../../automations/presentation/automations_tab.dart';
import '../../automations/providers/automations_providers.dart';
import '../data/scene_models.dart';
import '../providers/scenes_providers.dart';
import '../scene_icons.dart';
import '../widgets/scene_card.dart';
import 'scene_actions.dart';
import 'scene_schedules_sheet.dart';

/// "Kịch bản": scenes run with one tap, and automations ("Tự động") that run by themselves.
class ScenesScreen extends ConsumerStatefulWidget {
  const ScenesScreen({super.key});

  @override
  ConsumerState<ScenesScreen> createState() => _ScenesScreenState();
}

class _ScenesScreenState extends ConsumerState<ScenesScreen> with SingleTickerProviderStateMixin {
  late final TabController _tabs = TabController(length: 2, vsync: this);
  int _tab = 0;

  @override
  void initState() {
    super.initState();
    _tabs.addListener(() {
      if (_tabs.index != _tab) setState(() => _tab = _tabs.index);
    });
  }

  @override
  void dispose() {
    _tabs.dispose();
    super.dispose();
  }

  void _full(String message) =>
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));

  void _create() {
    if (_tab == 1) {
      final list = ref.read(automationsProvider).valueOrNull;
      if (list != null && list.isFull) {
        _full('Bạn đã có đủ ${list.maxAutomations} tự động hóa. Hãy xóa bớt cái không dùng.');
        return;
      }
      context.push(AppRoutes.automationNew);
      return;
    }
    final list = ref.read(scenesProvider).valueOrNull;
    if (list != null && list.isFull) {
      _full('Bạn đã có đủ ${list.maxScenes} kịch bản. Hãy xóa bớt kịch bản không dùng.');
      return;
    }
    context.push(AppRoutes.sceneNew);
  }

  @override
  Widget build(BuildContext context) {
    final scenes = ref.watch(scenesProvider).valueOrNull;
    return PageScaffold(
      scrollable: false,
      appBar: AppBar(
        title: const Text('Kịch bản'),
        centerTitle: false,
        actions: [
          IconButton(
            tooltip: 'Lịch sử chạy',
            icon: const Icon(Icons.history_rounded),
            onPressed: () => context.push(AppRoutes.sceneHistory),
          ),
          IconButton(
            tooltip: _tab == 1 ? 'Tạo tự động hóa' : 'Tạo kịch bản',
            icon: const Icon(Icons.add_rounded),
            onPressed: _create,
          ),
          if (_tab == 0 && (scenes?.scenes.length ?? 0) > 1)
            IconButton(
              tooltip: 'Sắp xếp',
              icon: const Icon(Icons.swap_vert_rounded),
              onPressed: () => showReorderSheet<Scene>(
                context,
                title: 'Sắp xếp kịch bản',
                items: scenes!.scenes,
                idOf: (scene) => scene.id,
                labelOf: (scene) => scene.name,
                iconOf: (scene) => sceneIcon(scene.icon),
                onSave: ref.read(scenesProvider.notifier).reorder,
              ),
            ),
        ],
        bottom: TabBar(
          controller: _tabs,
          tabs: const [Tab(text: 'Kịch bản'), Tab(text: 'Tự động')],
        ),
      ),
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
      child: TabBarView(
        controller: _tabs,
        children: [
          _ScenesTab(onCreate: _create),
          const AutomationsTab(),
        ],
      ),
    );
  }
}

class _ScenesTab extends ConsumerWidget {
  const _ScenesTab({required this.onCreate});

  final VoidCallback onCreate;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return ref.watch(scenesProvider).when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (error, _) => EmptyState(
            icon: LucideIcons.alertTriangle,
            title: 'Không tải được kịch bản',
            description: AppErrorMapper.mapError(error),
            actionText: 'Thử lại',
            onActionTap: () => ref.invalidate(scenesProvider),
          ),
          data: (list) => RefreshIndicator(
            onRefresh: () async {
              ref.invalidate(scenesProvider);
              try {
                await ref.read(scenesProvider.future);
              } catch (_) {}
            },
            child: list.scenes.isEmpty
                ? ListView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    children: [
                      const SizedBox(height: AppSpacing.xxl),
                      EmptyState(
                        icon: Icons.auto_awesome_rounded,
                        title: 'Chưa có kịch bản nào',
                        description: 'Gom nhiều thao tác vào một nút bấm, ví dụ "Ra khỏi nhà": '
                            'khóa cửa, đóng mái, bật tưới tự động.',
                        actionText: 'Tạo kịch bản',
                        onActionTap: onCreate,
                      ),
                    ],
                  )
                : ListView.separated(
                    physics: const AlwaysScrollableScrollPhysics(),
                    padding: const EdgeInsets.only(top: AppSpacing.sm, bottom: 120),
                    itemCount: list.scenes.length,
                    separatorBuilder: (_, __) => const SizedBox(height: AppSpacing.md),
                    itemBuilder: (context, index) {
                      final scene = list.scenes[index];
                      return SceneCard(
                        scene: scene,
                        onRun: () => runScene(context, ref, scene),
                        onOpen: () => context.push(AppRoutes.sceneEditOf(scene.id)),
                        menu: PopupMenuButton<String>(
                          tooltip: 'Tùy chọn',
                          onSelected: (value) {
                            if (value == 'edit') context.push(AppRoutes.sceneEditOf(scene.id));
                            if (value == 'schedule') showSceneSchedulesSheet(context, scene.id);
                            if (value == 'delete') deleteScene(context, ref, scene);
                          },
                          itemBuilder: (context) => [
                            const PopupMenuItem(
                              value: 'edit',
                              child: ListTile(leading: Icon(Icons.edit_rounded), title: Text('Sửa')),
                            ),
                            PopupMenuItem(
                              value: 'schedule',
                              child: ListTile(
                                leading: const Icon(Icons.schedule_rounded),
                                title: Text(scene.schedules.isEmpty
                                    ? 'Hẹn giờ'
                                    : 'Hẹn giờ (${scene.schedules.where((item) => item.enabled).length})'),
                              ),
                            ),
                            PopupMenuItem(
                              value: 'delete',
                              child: ListTile(
                                leading: Icon(Icons.delete_outline_rounded, color: context.colorScheme.error),
                                title: Text('Xóa', style: TextStyle(color: context.colorScheme.error)),
                              ),
                            ),
                          ],
                        ),
                      );
                    },
                  ),
          ),
        );
  }
}
