// Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V4
// Hallmark · component: irrigation control · genre: modern-minimal
// states: default · hover · focus · active · disabled · loading · error · success
import 'package:flutter/material.dart';

import '../../../core/core.dart';
import '../../../core/widgets/widgets.dart';
import '../../../domain/models/device_model.dart';
import '../../dashboard/models/capability_model.dart';
import 'product_mini_cards.dart';

class IrrigationControlPanel extends StatefulWidget {
  const IrrigationControlPanel({
    super.key,
    required this.device,
    required this.pumpState,
    required this.controlMode,
    required this.targetMoisture,
    required this.moistureHysteresis,
    required this.defaultCycleDuration,
    required this.maximumRuntime,
    required this.cooldown,
    required this.onCapabilityChanged,
  });

  final DeviceModel device;
  final CapabilityModel? pumpState;
  final CapabilityModel? controlMode;
  final CapabilityModel? targetMoisture;
  final CapabilityModel? moistureHysteresis;
  final CapabilityModel? defaultCycleDuration;
  final CapabilityModel? maximumRuntime;
  final CapabilityModel? cooldown;
  final ProductCapabilityChanged onCapabilityChanged;

  @override
  State<IrrigationControlPanel> createState() => _IrrigationControlPanelState();
}

class _IrrigationControlPanelState extends State<IrrigationControlPanel> {
  late int _selectedDuration = _initialDuration();
  bool _sendingPumpCommand = false;
  bool _sendingModeCommand = false;

  @override
  void didUpdateWidget(covariant IrrigationControlPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    final options = _durationOptions();
    if (!options.contains(_selectedDuration)) {
      _selectedDuration = _initialDuration();
    }
  }

  bool get _isOnline => widget.device.status == DeviceStatus.online;

  bool get _isPumping {
    final value = widget.pumpState?.value;
    if (value is bool) return value;
    return const {'running', 'on', 'active', 'true'}
        .contains('$value'.toLowerCase());
  }

  bool get _isAutomatic =>
      '${widget.controlMode?.value}'.toLowerCase() == 'automatic';

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

  Future<void> _changePumpState() async {
    final operationName = _isPumping ? 'stop' : 'water_for_duration';
    final capability = _forOperation(widget.pumpState, operationName);
    if (capability == null || _sendingPumpCommand) return;

    setState(() => _sendingPumpCommand = true);
    try {
      await widget.onCapabilityChanged(
        capability,
        _isPumping ? 'stopped' : _selectedDuration,
      );
    } finally {
      if (mounted) setState(() => _sendingPumpCommand = false);
    }
  }

  Future<void> _changeAutomaticMode(bool enabled) async {
    final capability = _forOperation(widget.controlMode, 'set_control_mode');
    if (capability == null || _sendingModeCommand) return;

    setState(() => _sendingModeCommand = true);
    try {
      await widget.onCapabilityChanged(
        capability,
        enabled ? 'automatic' : 'manual',
      );
    } finally {
      if (mounted) setState(() => _sendingModeCommand = false);
    }
  }

  int _initialDuration() {
    final options = _durationOptions();
    final configured = _integerValue(widget.defaultCycleDuration) ?? 300;
    if (options.contains(configured)) return configured;
    return options.lastWhere(
      (duration) => duration <= configured,
      orElse: () => options.first,
    );
  }

  List<int> _durationOptions() {
    final maximum =
        (_integerValue(widget.maximumRuntime) ?? 900).clamp(30, 3600);
    final configured =
        (_integerValue(widget.defaultCycleDuration) ?? 300).clamp(30, maximum);
    final options = <int>{
      30,
      60,
      300,
      600,
      900,
      configured,
      maximum,
    }.where((duration) => duration <= maximum).toList()
      ..sort();
    return options;
  }

  @override
  Widget build(BuildContext context) {
    final pumpOperation = _forOperation(
      widget.pumpState,
      _isPumping ? 'stop' : 'water_for_duration',
    );
    final modeOperation = _forOperation(widget.controlMode, 'set_control_mode');
    final pumpEnabled = _isOnline &&
        pumpOperation != null &&
        !_sendingPumpCommand &&
        !_sendingModeCommand;
    final modeEnabled = _isOnline &&
        modeOperation != null &&
        !_sendingModeCommand &&
        !_sendingPumpCommand;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            NeuIconBox(
              icon: Icons.water_drop_rounded,
              size: 44,
              iconSize: 22,
              isActive: _isPumping,
            ),
            const SizedBox(width: AppSpacing.smMd),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Điều khiển tưới', style: context.textTheme.titleLarge),
                  const SizedBox(height: AppSpacing.xs),
                  Text(
                    'Chọn thời gian rồi bắt đầu một lần tưới thủ công.',
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
              Text('Tưới thủ công', style: context.textTheme.titleMedium),
              const SizedBox(height: AppSpacing.sm),
              DropdownButtonFormField<int>(
                key: ValueKey(_selectedDuration),
                value: _selectedDuration,
                decoration: const InputDecoration(
                  labelText: 'Thời gian tưới',
                ),
                items: _durationOptions()
                    .map(
                      (duration) => DropdownMenuItem<int>(
                        value: duration,
                        child: Text(_formatDuration(duration)),
                      ),
                    )
                    .toList(growable: false),
                onChanged: !_isOnline || _isPumping || _sendingPumpCommand
                    ? null
                    : (duration) {
                        if (duration != null) {
                          setState(() => _selectedDuration = duration);
                        }
                      },
              ),
              const SizedBox(height: AppSpacing.sm),
              Text(
                _pumpHelperText(pumpOperation),
                style: context.textTheme.bodySmall?.copyWith(
                  color: context.colorScheme.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: AppSpacing.md),
              SizedBox(
                width: double.infinity,
                child: FilledButton.icon(
                  onPressed: pumpEnabled ? _changePumpState : null,
                  icon: _sendingPumpCommand
                      ? const SizedBox.square(
                          dimension: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : Icon(
                          _isPumping
                              ? Icons.stop_rounded
                              : Icons.water_drop_rounded,
                        ),
                  label: Text(
                    _sendingPumpCommand
                        ? 'Đang gửi lệnh…'
                        : _isPumping
                            ? 'Dừng tưới'
                            : 'Tưới nước',
                  ),
                ),
              ),
              const SizedBox(height: AppSpacing.lg),
              Divider(color: context.colorScheme.outlineVariant),
              const SizedBox(height: AppSpacing.sm),
              SwitchListTile.adaptive(
                contentPadding: EdgeInsets.zero,
                title: const Text('Tự động tưới'),
                subtitle: Text(
                  _sendingModeCommand
                      ? 'Đang gửi thay đổi…'
                      : _isAutomatic
                          ? 'Thiết bị tự quyết định tại chỗ theo cảm biến.'
                          : 'Bạn chủ động bắt đầu từng lần tưới.',
                ),
                value: _isAutomatic,
                onChanged: modeEnabled ? _changeAutomaticMode : null,
              ),
              const SizedBox(height: AppSpacing.sm),
              _InformationNote(
                icon: Icons.health_and_safety_outlined,
                text: _firmwarePolicyNote(),
              ),
            ],
          ),
        ),
      ],
    );
  }

  String _pumpHelperText(CapabilityModel? operation) {
    if (!_isOnline) return 'Thiết bị đang ngoại tuyến nên chưa thể nhận lệnh.';
    if (operation == null) {
      return 'Tài khoản này không có quyền điều khiển bơm tưới.';
    }
    if (_isPumping) return 'Bơm sẽ tiếp tục chạy cho đến khi chu kỳ kết thúc.';
    final maximum = _integerValue(widget.maximumRuntime);
    return maximum == null
        ? 'Thiết bị tự kiểm tra nguồn nước trước khi chạy bơm.'
        : 'Mỗi lần tưới không vượt quá ${_formatDuration(maximum)}.';
  }

  String _firmwarePolicyNote() {
    final target = _plainNumber(widget.targetMoisture?.value);
    final hysteresis = _plainNumber(widget.moistureHysteresis?.value);
    final cycle = _integerValue(widget.defaultCycleDuration);
    final maximum = _integerValue(widget.maximumRuntime);
    final cooldown = _integerValue(widget.cooldown);
    if (target == null ||
        hysteresis == null ||
        cycle == null ||
        maximum == null ||
        cooldown == null) {
      return 'Ở chế độ tự động, thiết bị tự dùng ngưỡng độ ẩm, vùng trễ và các giới hạn an toàn cố định để bảo vệ bơm.';
    }
    return 'Ở chế độ tự động, thiết bị dùng ngưỡng độ ẩm $target/100 và vùng trễ $hysteresis/100 để tránh bật/tắt bơm liên tục. '
        'Mỗi chu kỳ kéo dài ${_formatDuration(cycle)}; bơm tự dừng sau tối đa ${_formatDuration(maximum)} và nghỉ ít nhất ${_formatDuration(cooldown)} trước lần chạy tiếp theo.';
  }
}

class _InformationNote extends StatelessWidget {
  const _InformationNote({required this.icon, required this.text});

  final IconData icon;
  final String text;

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
              Icon(icon, size: 20, color: context.colorScheme.primary),
              const SizedBox(width: AppSpacing.sm),
              Expanded(child: Text(text, style: context.textTheme.bodySmall)),
            ],
          ),
        ),
      );
}

int? _integerValue(CapabilityModel? capability) {
  final value = capability?.value;
  if (value is num) return value.round();
  return int.tryParse('$value');
}

String? _plainNumber(dynamic value) {
  if (value is int) return value.toString();
  if (value is double && value == value.roundToDouble()) {
    return value.toInt().toString();
  }
  if (value is num) return value.toStringAsFixed(1);
  return value == null ? null : '$value';
}

String _formatDuration(int seconds) {
  if (seconds < 60) return '$seconds giây';
  if (seconds % 60 == 0) return '${seconds ~/ 60} phút';
  return '${seconds ~/ 60} phút ${seconds % 60} giây';
}
