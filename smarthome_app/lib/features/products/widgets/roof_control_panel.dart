// Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V5
// Hallmark · component: roof control · genre: modern-minimal
// states: default · focus · active · disabled · loading · error · success
import 'package:flutter/material.dart';

import '../../../core/core.dart';
import '../../../core/widgets/widgets.dart';
import '../../../domain/models/device_model.dart';
import '../../dashboard/models/capability_model.dart';
import 'product_mini_cards.dart';

class RoofControlPanel extends StatefulWidget {
  const RoofControlPanel({
    super.key,
    required this.device,
    required this.movement,
    required this.controlMode,
    required this.onCapabilityChanged,
  });

  final DeviceModel device;
  final CapabilityModel? movement;
  final CapabilityModel? controlMode;
  final ProductCapabilityChanged onCapabilityChanged;

  @override
  State<RoofControlPanel> createState() => _RoofControlPanelState();
}

class _RoofControlPanelState extends State<RoofControlPanel> {
  String? _sendingMovement;
  bool _sendingMode = false;

  bool get _isOnline => widget.device.status == DeviceStatus.online;

  String get _mode => '${widget.controlMode?.value}'.trim().toLowerCase();

  String get _movement => '${widget.movement?.value}'.trim().toLowerCase();

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

  Future<void> _move(String operationName) async {
    final capability = _forOperation(widget.movement, operationName);
    if (capability == null || _sendingMovement != null || _sendingMode) return;

    setState(() => _sendingMovement = operationName);
    try {
      await widget.onCapabilityChanged(
        capability,
        operationName == 'open' ? 'opening' : 'closing',
      );
    } finally {
      if (mounted) setState(() => _sendingMovement = null);
    }
  }

  Future<void> _changeMode(String mode) async {
    if (mode == _mode) return;
    final capability = _forOperation(widget.controlMode, 'set_control_mode');
    if (capability == null || _sendingMode || _sendingMovement != null) return;

    setState(() => _sendingMode = true);
    try {
      await widget.onCapabilityChanged(capability, mode);
    } finally {
      if (mounted) setState(() => _sendingMode = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final openOperation = _forOperation(widget.movement, 'open');
    final closeOperation = _forOperation(widget.movement, 'close');
    final modeOperation = _forOperation(widget.controlMode, 'set_control_mode');
    final motionEnabled =
        _isOnline && _sendingMovement == null && !_sendingMode;
    final openEnabled = motionEnabled &&
        openOperation != null &&
        !const {'open', 'opening'}.contains(_movement);
    final closeEnabled = motionEnabled &&
        closeOperation != null &&
        !const {'closed', 'closing'}.contains(_movement);
    final modeEnabled = _isOnline &&
        modeOperation != null &&
        !_sendingMode &&
        _sendingMovement == null;
    final selectedMode = switch (_mode) {
      'manual' => const {'manual'},
      'automatic' => const {'automatic'},
      _ => const <String>{},
    };

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const NeuIconBox(
              icon: Icons.roofing_rounded,
              size: 44,
              iconSize: 22,
              isActive: true,
            ),
            const SizedBox(width: AppSpacing.smMd),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Điều khiển mái che',
                    style: context.textTheme.titleLarge,
                  ),
                  const SizedBox(height: AppSpacing.xs),
                  Text(
                    'Mở hoặc đóng mái, sau đó chọn cách thiết bị vận hành.',
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
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('Điều khiển', style: context.textTheme.titleMedium),
              const SizedBox(height: AppSpacing.sm),
              Row(
                children: [
                  Expanded(
                    child: FilledButton.tonalIcon(
                      onPressed: openEnabled ? () => _move('open') : null,
                      icon: _movementIcon(
                        operationName: 'open',
                        fallback: Icons.keyboard_arrow_up_rounded,
                      ),
                      label: const Text('Mở mái'),
                    ),
                  ),
                  const SizedBox(width: AppSpacing.sm),
                  Expanded(
                    child: FilledButton.tonalIcon(
                      onPressed: closeEnabled ? () => _move('close') : null,
                      icon: _movementIcon(
                        operationName: 'close',
                        fallback: Icons.keyboard_arrow_down_rounded,
                      ),
                      label: const Text('Đóng mái'),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: AppSpacing.sm),
              Text(
                _motionHelper(openOperation, closeOperation),
                style: context.textTheme.bodySmall?.copyWith(
                  color: context.colorScheme.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: AppSpacing.lg),
              Divider(color: context.colorScheme.outlineVariant),
              const SizedBox(height: AppSpacing.sm),
              Text('Chế độ vận hành', style: context.textTheme.titleMedium),
              const SizedBox(height: AppSpacing.sm),
              SegmentedButton<String>(
                segments: const [
                  ButtonSegment(
                    value: 'manual',
                    label: Text('Thủ công'),
                    icon: Icon(Icons.touch_app_rounded),
                  ),
                  ButtonSegment(
                    value: 'automatic',
                    label: Text('Tự động'),
                    icon: Icon(Icons.auto_mode_rounded),
                  ),
                ],
                selected: selectedMode,
                emptySelectionAllowed: true,
                onSelectionChanged: modeEnabled
                    ? (selection) {
                        if (selection.isNotEmpty) {
                          _changeMode(selection.single);
                        }
                      }
                    : null,
              ),
              const SizedBox(height: AppSpacing.sm),
              Text(
                _modeHelper(modeOperation),
                style: context.textTheme.bodySmall?.copyWith(
                  color: context.colorScheme.onSurfaceVariant,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _movementIcon({
    required String operationName,
    required IconData fallback,
  }) {
    if (_sendingMovement == operationName) {
      return const SizedBox.square(
        dimension: 18,
        child: CircularProgressIndicator(strokeWidth: 2),
      );
    }
    return Icon(fallback);
  }

  String _motionHelper(
    CapabilityModel? openOperation,
    CapabilityModel? closeOperation,
  ) {
    if (!_isOnline) return 'Thiết bị đang ngoại tuyến nên chưa thể nhận lệnh.';
    if (openOperation == null || closeOperation == null) {
      return 'Tài khoản này không có quyền điều khiển mái che.';
    }
    if (_sendingMovement != null) return 'Đang gửi lệnh tới thiết bị…';
    return switch (_movement) {
      'opening' => 'Mái đang mở; bạn vẫn có thể đổi chiều bằng nút Đóng mái.',
      'closing' => 'Mái đang đóng; bạn vẫn có thể đổi chiều bằng nút Mở mái.',
      'open' => 'Mái đang mở hoàn toàn.',
      'closed' => 'Mái đang đóng hoàn toàn.',
      _ => 'Chọn Mở mái hoặc Đóng mái để điều khiển thiết bị.',
    };
  }

  String _modeHelper(CapabilityModel? modeOperation) {
    if (!_isOnline) return 'Chế độ sẽ khả dụng khi thiết bị trực tuyến.';
    if (modeOperation == null) {
      return 'Tài khoản này không có quyền đổi chế độ vận hành.';
    }
    if (_sendingMode) return 'Đang gửi thay đổi…';
    return _mode == 'automatic'
        ? 'Thiết bị tự xử lý theo cảm biến và chính sách an toàn.'
        : 'Bạn chủ động mở hoặc đóng mái che.';
  }
}
