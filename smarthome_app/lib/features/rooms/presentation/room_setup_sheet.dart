import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/core.dart';
import '../../../core/utils/app_error_mapper.dart';
import '../../dashboard/providers/devices_provider.dart';
import '../data/room_models.dart';
import '../providers/rooms_providers.dart';
import '../room_icons.dart';

/// Shows the suggested rooms; the ticked ones are created and filled in one step.
Future<void> showRoomSetupSheet(BuildContext context, List<RoomDraft> drafts) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    useRootNavigator: true,
    builder: (_) => _RoomSetupSheet(drafts: drafts),
  );
}

class _RoomSetupSheet extends ConsumerStatefulWidget {
  const _RoomSetupSheet({required this.drafts});

  final List<RoomDraft> drafts;

  @override
  ConsumerState<_RoomSetupSheet> createState() => _RoomSetupSheetState();
}

class _RoomSetupSheetState extends ConsumerState<_RoomSetupSheet> {
  late final Set<int> _chosen = {for (var index = 0; index < widget.drafts.length; index++) index};
  bool _saving = false;
  String? _error;

  Future<void> _apply() async {
    final drafts = [for (final index in _chosen.toList()..sort()) widget.drafts[index]];
    if (drafts.isEmpty) return;
    setState(() {
      _saving = true;
      _error = null;
    });
    final messenger = ScaffoldMessenger.of(context);
    try {
      await ref.read(roomsProvider.notifier).setup(drafts);
      if (!mounted) return;
      Navigator.of(context).pop();
      messenger.showSnackBar(SnackBar(content: Text('Đã xếp thiết bị vào ${drafts.length} phòng')));
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _error = AppErrorMapper.mapError(error);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final devices = ref.watch(devicesProvider).valueOrNull ?? const [];
    final nameByMac = {for (final device in devices) device.mac: device.name};
    final maxHeight = MediaQuery.sizeOf(context).height * 0.75;

    return ConstrainedBox(
      constraints: BoxConstraints(maxHeight: maxHeight),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
            child: Text('Gợi ý xếp phòng', style: context.textTheme.titleLarge),
          ),
          const SizedBox(height: AppSpacing.xs),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
            child: Text(
              'Dựa trên loại thiết bị chưa có phòng. Phòng trùng tên với phòng bạn đã có sẽ được dùng lại; '
              'sau này bạn vẫn đổi tên hoặc chuyển thiết bị được.',
              style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant),
            ),
          ),
          const SizedBox(height: AppSpacing.sm),
          Flexible(
            child: ListView(
              shrinkWrap: true,
              children: [
                for (var index = 0; index < widget.drafts.length; index++)
                  CheckboxListTile(
                    value: _chosen.contains(index),
                    onChanged: _saving
                        ? null
                        : (checked) => setState(() {
                              if (checked == true) {
                                _chosen.add(index);
                              } else {
                                _chosen.remove(index);
                              }
                            }),
                    secondary: Icon(roomIcon(widget.drafts[index].icon)),
                    title: Text(widget.drafts[index].name),
                    subtitle: Text(
                      widget.drafts[index].macs.map((mac) => nameByMac[mac] ?? mac).join(', '),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
              ],
            ),
          ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(AppSpacing.lg, AppSpacing.sm, AppSpacing.lg, 0),
              child: Text(_error!, style: TextStyle(color: context.colorScheme.error)),
            ),
          Padding(
            padding: const EdgeInsets.all(AppSpacing.lg),
            child: FilledButton(
              onPressed: _saving || _chosen.isEmpty ? null : _apply,
              child: _saving
                  ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                  : Text('Tạo ${_chosen.length} phòng'),
            ),
          ),
        ],
      ),
    );
  }
}
