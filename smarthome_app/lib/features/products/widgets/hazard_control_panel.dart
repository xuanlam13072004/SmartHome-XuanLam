// Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V5
// Hallmark · component: hazard siren control · genre: modern-minimal
// states: default · active · disabled · loading · offline · permission-limited
import 'package:flutter/material.dart';

import '../../../core/core.dart';
import '../../../core/widgets/widgets.dart';
import '../../../domain/models/device_model.dart';
import '../../dashboard/models/capability_model.dart';
import 'product_mini_cards.dart';

const int _sirenTestDurationSeconds = 5;

class HazardControlPanel extends StatefulWidget {
  const HazardControlPanel({
    super.key,
    required this.device,
    required this.sirenState,
    required this.muteUntil,
    required this.testSiren,
    required this.onCapabilityChanged,
  });

  final DeviceModel device;
  final CapabilityModel? sirenState;
  final CapabilityModel? muteUntil;
  final CapabilityModel? testSiren;
  final ProductCapabilityChanged onCapabilityChanged;

  @override
  State<HazardControlPanel> createState() => _HazardControlPanelState();
}

class _HazardControlPanelState extends State<HazardControlPanel> {
  String? _pendingOperation;
  int _selectedMuteDuration = 60;

  bool get _isOnline => widget.device.status == DeviceStatus.online;

  String get _state => '${widget.sirenState?.value}'.trim().toLowerCase();

  bool get _isSounding => _state == 'sounding';

  bool get _isMuted => _state == 'muted';

  CapabilityModel? _forOperation(
    CapabilityModel? source,
    String operationName,
  ) {
    if (source == null) return null;
    final matches = source.operations
        .where((operation) => operation.operationName == operationName)
        .toList(growable: false);
    if (matches.length != 1) return null;
    return source.copyWith(
      isReadOnly: false,
      operations: [matches.single],
    );
  }

  List<int> _muteDurations(CapabilityModel? capability) {
    if (capability == null || capability.operations.length != 1) {
      return const [60];
    }
    final durationSchema =
        capability.operations.single.inputSchema['duration_seconds'];
    if (durationSchema is! Map) return const [60];
    final values = (durationSchema['enum'] as List? ?? const [])
        .whereType<num>()
        .map((value) => value.toInt())
        .where((value) => value > 0)
        .toSet()
        .toList()
      ..sort();
    return values.isEmpty ? const [60] : values;
  }

  Future<void> _run(
    String operationName,
    CapabilityModel? capability,
    dynamic value,
  ) async {
    if (capability == null || _pendingOperation != null) return;
    setState(() => _pendingOperation = operationName);
    try {
      await widget.onCapabilityChanged(capability, value);
    } finally {
      if (mounted) setState(() => _pendingOperation = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final testOperation = _forOperation(widget.testSiren, 'test_siren');
    final muteOperation = _forOperation(widget.sirenState, 'mute_siren');
    final muteDurations = _muteDurations(muteOperation);
    final selectedMuteDuration = muteDurations.contains(_selectedMuteDuration)
        ? _selectedMuteDuration
        : muteDurations.first;
    final isBusy = _pendingOperation != null;
    final canTest =
        _isOnline && testOperation != null && !_isSounding && !isBusy;
    final canMute =
        _isOnline && muteOperation != null && _isSounding && !isBusy;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            NeuIconBox(
              icon: _isSounding
                  ? Icons.notifications_active_rounded
                  : Icons.notifications_off_rounded,
              size: 44,
              iconSize: 22,
              isActive: _isSounding,
              iconColor: _isSounding
                  ? context.colorScheme.error
                  : context.colorScheme.primary,
              activeIconColor: context.colorScheme.error,
            ),
            const SizedBox(width: AppSpacing.smMd),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Còi báo động', style: context.textTheme.titleLarge),
                  const SizedBox(height: AppSpacing.xs),
                  Text(
                    'Kiểm tra còi hoặc tắt âm tạm thời khi có cảnh báo.',
                    style: context.textTheme.bodySmall,
                  ),
                ],
              ),
            ),
          ],
        ),
        const SizedBox(height: AppSpacing.md),
        NeuCard(
          padding: const EdgeInsets.all(AppSpacing.md),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Semantics(
                liveRegion: true,
                label: 'Trạng thái còi: ${_stateLabel()}',
                child: Row(
                  children: [
                    Icon(
                      _isSounding
                          ? Icons.volume_up_rounded
                          : _isMuted
                              ? Icons.volume_off_rounded
                              : Icons.volume_mute_rounded,
                      color: _isSounding
                          ? context.colorScheme.error
                          : context.colorScheme.primary,
                    ),
                    const SizedBox(width: AppSpacing.sm),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('Trạng thái còi',
                              style: context.textTheme.labelSmall),
                          const SizedBox(height: AppSpacing.xs),
                          Text(
                            _stateLabel(),
                            style: context.textTheme.titleMedium?.copyWith(
                              color: _isSounding
                                  ? context.colorScheme.error
                                  : context.colorScheme.primary,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: AppSpacing.md),
              Row(
                children: [
                  Expanded(
                    child: Text(
                      'Thời gian tắt còi',
                      style: context.textTheme.labelLarge,
                    ),
                  ),
                  const SizedBox(width: AppSpacing.sm),
                  SizedBox(
                    width: 132,
                    child: DropdownButtonFormField<int>(
                      value: selectedMuteDuration,
                      isExpanded: true,
                      decoration: const InputDecoration(
                        isDense: true,
                        contentPadding: EdgeInsets.symmetric(
                          horizontal: AppSpacing.smMd,
                          vertical: AppSpacing.sm,
                        ),
                      ),
                      items: muteDurations
                          .map(
                            (seconds) => DropdownMenuItem(
                              value: seconds,
                              child: Text(_durationLabel(seconds)),
                            ),
                          )
                          .toList(growable: false),
                      onChanged: _isOnline && muteOperation != null && !isBusy
                          ? (value) {
                              if (value == null) return;
                              setState(() => _selectedMuteDuration = value);
                            }
                          : null,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: AppSpacing.md),
              LayoutBuilder(
                builder: (context, constraints) {
                  final stackButtons = constraints.maxWidth < 400;
                  final testButton = FilledButton.icon(
                    onPressed: canTest
                        ? () => _run(
                              'test_siren',
                              testOperation,
                              _sirenTestDurationSeconds,
                            )
                        : null,
                    icon: _operationIcon(
                      'test_siren',
                      Icons.volume_up_rounded,
                    ),
                    label: Text(
                      _pendingOperation == 'test_siren'
                          ? 'Đang bật còi…'
                          : 'Bật còi',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  );
                  final muteButton = OutlinedButton.icon(
                    onPressed: canMute
                        ? () => _run(
                              'mute_siren',
                              muteOperation,
                              selectedMuteDuration,
                            )
                        : null,
                    icon: _operationIcon(
                      'mute_siren',
                      Icons.volume_off_rounded,
                    ),
                    label: Text(
                      _pendingOperation == 'mute_siren'
                          ? 'Đang tắt còi…'
                          : 'Tắt còi tạm thời',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  );

                  if (stackButtons) {
                    return Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        SizedBox(height: 48, child: testButton),
                        const SizedBox(height: AppSpacing.sm),
                        SizedBox(height: 48, child: muteButton),
                      ],
                    );
                  }
                  return Row(
                    children: [
                      Expanded(child: SizedBox(height: 48, child: testButton)),
                      const SizedBox(width: AppSpacing.sm),
                      Expanded(child: SizedBox(height: 48, child: muteButton)),
                    ],
                  );
                },
              ),
              const SizedBox(height: AppSpacing.sm),
              Text(
                _helperText(testOperation, muteOperation),
                style: context.textTheme.bodySmall?.copyWith(
                  color: context.colorScheme.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: AppSpacing.lg),
              Divider(color: context.colorScheme.outlineVariant),
              const SizedBox(height: AppSpacing.sm),
              _MutePolicyNote(
                isMuted: _isMuted,
                muteUntil: widget.muteUntil?.value,
                selectedDuration: selectedMuteDuration,
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _operationIcon(String operationName, IconData fallback) {
    if (_pendingOperation != operationName) return Icon(fallback);
    return const SizedBox.square(
      dimension: 18,
      child: CircularProgressIndicator(strokeWidth: 2),
    );
  }

  String _stateLabel() => switch (_state) {
        'sounding' => 'Đang kêu',
        'muted' => 'Đang tắt tạm thời',
        'silent' => 'Đang tắt',
        _ => 'Chưa xác định',
      };

  String _durationLabel(int seconds) {
    if (seconds < 60) return '$seconds giây';
    return '${seconds ~/ 60} phút';
  }

  String _helperText(
    CapabilityModel? testOperation,
    CapabilityModel? muteOperation,
  ) {
    if (!_isOnline) return 'Thiết bị đang ngoại tuyến nên chưa thể nhận lệnh.';
    if (testOperation == null && muteOperation == null) {
      return 'Tài khoản này không có quyền điều khiển còi.';
    }
    if (_isSounding) {
      return muteOperation == null
          ? 'Còi đang kêu nhưng tài khoản này không có quyền tắt âm.'
          : 'Tắt âm không kết thúc cảnh báo và không ngừng việc giám sát.';
    }
    if (_isMuted) {
      return 'Còi đang tắt tạm thời; thiết bị vẫn tiếp tục theo dõi nguy hiểm.';
    }
    return 'Bật còi sẽ chạy một lần kiểm tra trong $_sirenTestDurationSeconds giây.';
  }
}

class _MutePolicyNote extends StatelessWidget {
  const _MutePolicyNote({
    required this.isMuted,
    required this.muteUntil,
    required this.selectedDuration,
  });

  final bool isMuted;
  final dynamic muteUntil;
  final int selectedDuration;

  String _deadlineLabel() {
    final deadline = DateTime.tryParse('${muteUntil ?? ''}')?.toLocal();
    if (deadline == null) return '';
    String twoDigits(int value) => value.toString().padLeft(2, '0');
    return '${twoDigits(deadline.hour)}:${twoDigits(deadline.minute)}:'
        '${twoDigits(deadline.second)}';
  }

  String _durationLabel() => selectedDuration < 60
      ? '$selectedDuration giây'
      : '${selectedDuration ~/ 60} phút';

  String _description() {
    final deadline = _deadlineLabel();
    if (isMuted && deadline.isNotEmpty) {
      return 'Còi đang tắt đến $deadline. Thiết bị vẫn giám sát và sẽ tự bật '
          'lại nếu nguy hiểm còn tồn tại.';
    }
    if (isMuted) {
      return 'Còi đang tắt tạm thời. Thiết bị vẫn giám sát và sẽ tự bật lại '
          'nếu nguy hiểm còn tồn tại.';
    }
    return 'Đang chọn ${_durationLabel()}. Tắt âm không xóa cảnh báo; còi sẽ '
        'tự bật lại khi hết hạn nếu nguy hiểm còn tồn tại.';
  }

  @override
  Widget build(BuildContext context) => DecoratedBox(
        decoration: BoxDecoration(
          color: context.colorScheme.primaryContainer.withValues(alpha: 0.45),
          borderRadius: BorderRadius.circular(AppRadius.smMd),
        ),
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.smMd),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(
                Icons.timer_outlined,
                size: 20,
                color: context.colorScheme.primary,
              ),
              const SizedBox(width: AppSpacing.sm),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Thời gian tắt còi cảnh báo',
                      style: context.textTheme.labelLarge?.copyWith(
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: AppSpacing.xs),
                    Text(
                      _description(),
                      style: context.textTheme.bodySmall,
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      );
}
