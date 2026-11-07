// Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4
// Component states: default · focus · active · disabled · loading · error · success
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../core/core.dart';
import '../../../core/widgets/widgets.dart';
import '../../dashboard/models/capability_model.dart';
import 'product_mini_cards.dart';

const _lcdRows = 4;
const _lcdColumns = 20;

class EntranceLcdPanel extends StatefulWidget {
  const EntranceLcdPanel({
    super.key,
    required this.linesCapability,
    required this.deviceOnline,
    required this.onCapabilityChanged,
    this.sourceCapability,
  });

  final CapabilityModel linesCapability;
  final CapabilityModel? sourceCapability;
  final bool deviceOnline;
  final ProductCapabilityChanged onCapabilityChanged;

  @override
  State<EntranceLcdPanel> createState() => _EntranceLcdPanelState();
}

class _EntranceLcdPanelState extends State<EntranceLcdPanel> {
  late final List<TextEditingController> _controllers;
  var _dirty = false;
  var _saving = false;
  var _feedback = '';
  var _feedbackIsError = false;

  @override
  void initState() {
    super.initState();
    final lines = _normalizeLines(widget.linesCapability.value);
    _controllers = List.generate(
      _lcdRows,
      (index) => TextEditingController(text: lines[index]),
    );
  }

  @override
  void didUpdateWidget(covariant EntranceLcdPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!_dirty &&
        oldWidget.linesCapability.value != widget.linesCapability.value) {
      _replaceDraft(_normalizeLines(widget.linesCapability.value));
    }
  }

  @override
  void dispose() {
    for (final controller in _controllers) {
      controller.dispose();
    }
    super.dispose();
  }

  List<String> get _draftLines =>
      _controllers.map((controller) => controller.text).toList(growable: false);

  bool get _canWrite =>
      widget.deviceOnline &&
      widget.linesCapability.operations
          .any((operation) => operation.operationName == 'set_custom_message');

  bool get _canRestore =>
      widget.deviceOnline &&
      widget.sourceCapability != null &&
      widget.sourceCapability!.operations.any(
          (operation) => operation.operationName == 'clear_custom_message');

  void _replaceDraft(List<String> lines) {
    for (var index = 0; index < _lcdRows; index++) {
      _controllers[index].value = TextEditingValue(
        text: lines[index],
        selection: TextSelection.collapsed(offset: lines[index].length),
      );
    }
  }

  void _markEdited() {
    setState(() {
      _dirty = true;
      _feedback = '';
      _feedbackIsError = false;
    });
  }

  Future<void> _showOnLcd() async {
    if (!_canWrite || _saving) return;
    final submitted = _draftLines;
    setState(() {
      _saving = true;
      _feedback = '';
      _feedbackIsError = false;
    });
    try {
      await widget.onCapabilityChanged(widget.linesCapability, submitted);
      if (!mounted) return;
      setState(() {
        _dirty = _draftLines.join('\u0000') != submitted.join('\u0000');
        _feedback = 'Đã gửi lời nhắn tới màn hình cửa.';
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _feedback = 'Chưa gửi được lời nhắn. Kiểm tra kết nối rồi thử lại.';
        _feedbackIsError = true;
      });
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _restoreFirmware() async {
    final source = widget.sourceCapability;
    if (!_canRestore || _saving || source == null) return;
    setState(() {
      _saving = true;
      _feedback = '';
      _feedbackIsError = false;
    });
    try {
      await widget.onCapabilityChanged(source, 'firmware');
      if (!mounted) return;
      setState(() {
        _dirty = false;
        _feedback = 'Màn hình cửa đã về nội dung mặc định.';
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _feedback = 'Chưa đưa được màn hình về mặc định. Hãy thử lại.';
        _feedbackIsError = true;
      });
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final lines = _draftLines;
    final source = '${widget.sourceCapability?.value}'.trim().toLowerCase();
    final sourceLabel = switch (source) {
      'custom' => 'Đang hiện lời nhắn',
      'authentication' => 'Đang xác thực',
      'safety' => 'Cảnh báo an toàn',
      _ => 'Mặc định',
    };

    return NeuCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const NeuIconBox(
                icon: Icons.developer_board_rounded,
                size: 44,
                iconSize: 22,
                isActive: true,
              ),
              const SizedBox(width: AppSpacing.smMd),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Màn hình cửa', style: context.textTheme.titleLarge),
                    const SizedBox(height: AppSpacing.xs),
                    Text(
                      'Tối đa 4 dòng, mỗi dòng 20 ký tự.',
                      style: context.textTheme.bodySmall,
                    ),
                  ],
                ),
              ),
              const SizedBox(width: AppSpacing.sm),
              Text(
                sourceLabel,
                style: context.textTheme.labelSmall?.copyWith(
                  color: context.colorScheme.primary,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.mdLg),
          _CharacterLcd(lines: lines),
          const SizedBox(height: AppSpacing.lg),
          for (var index = 0; index < _lcdRows; index++) ...[
            TextField(
              key: ValueKey('entrance-lcd-line-$index'),
              controller: _controllers[index],
              enabled: _canWrite && !_saving,
              maxLength: _lcdColumns,
              maxLines: 1,
              textInputAction: index == _lcdRows - 1
                  ? TextInputAction.done
                  : TextInputAction.next,
              inputFormatters: [LengthLimitingTextInputFormatter(_lcdColumns)],
              onChanged: (_) => _markEdited(),
              decoration: InputDecoration(
                labelText: 'Dòng ${index + 1}',
                hintText: 'Nội dung dòng ${index + 1}',
                counterText:
                    '${_controllers[index].text.characters.length}/$_lcdColumns',
                filled: true,
                fillColor: context.colorScheme.surfaceContainerLowest,
                border: const OutlineInputBorder(
                  borderRadius:
                      BorderRadius.all(Radius.circular(AppRadius.smMd)),
                ),
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(AppRadius.smMd),
                  borderSide:
                      BorderSide(color: context.colorScheme.outlineVariant),
                ),
                focusedBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(AppRadius.smMd),
                  borderSide: BorderSide(color: context.colorScheme.primary),
                ),
              ),
            ),
            if (index != _lcdRows - 1) const SizedBox(height: AppSpacing.sm),
          ],
          const SizedBox(height: AppSpacing.md),
          LayoutBuilder(
            builder: (context, constraints) {
              final compact = constraints.maxWidth < 380;
              final primary = FilledButton.icon(
                onPressed: _canWrite && !_saving ? _showOnLcd : null,
                icon: _saving
                    ? const SizedBox.square(
                        dimension: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.dvr_rounded),
                label: Text(_saving ? 'Đang gửi…' : 'Hiển thị lời nhắn'),
              );
              final secondary = OutlinedButton.icon(
                onPressed: _canRestore && source == 'custom' && !_saving
                    ? _restoreFirmware
                    : null,
                icon: const Icon(Icons.settings_backup_restore_rounded),
                label: const Text('Về mặc định'),
              );
              if (compact) {
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    primary,
                    const SizedBox(height: AppSpacing.sm),
                    secondary
                  ],
                );
              }
              return Row(
                children: [
                  Expanded(child: primary),
                  const SizedBox(width: AppSpacing.sm),
                  Expanded(child: secondary),
                ],
              );
            },
          ),
          const SizedBox(height: AppSpacing.sm),
          Semantics(
            liveRegion: true,
            child: Text(
              _feedback.isNotEmpty
                  ? _feedback
                  : widget.deviceOnline
                      ? 'Thông báo an toàn và xác thực luôn được ưu tiên hiển thị.'
                      : 'Thiết bị đang ngoại tuyến nên chưa thể nhận nội dung mới.',
              style: context.textTheme.bodySmall?.copyWith(
                color: _feedbackIsError
                    ? context.colorScheme.error
                    : context.colorScheme.onSurfaceVariant,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _CharacterLcd extends StatelessWidget {
  const _CharacterLcd({required this.lines});

  final List<String> lines;

  @override
  Widget build(BuildContext context) {
    final foreground = context.colorScheme.onInverseSurface;
    return Semantics(
      label: 'Màn hình LCD: ${lines.join(', ')}',
      image: true,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: context.colorScheme.inverseSurface,
          borderRadius: BorderRadius.circular(AppRadius.smMd),
        ),
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.sm),
          child: Column(
            children: [
              for (var row = 0; row < _lcdRows; row++)
                Row(
                  children: [
                    for (var column = 0; column < _lcdColumns; column++)
                      Expanded(
                        child: Container(
                          height: 22,
                          alignment: Alignment.center,
                          decoration: BoxDecoration(
                            border: Border.all(
                              color: foreground.withValues(alpha: 0.12),
                              width: 0.5,
                            ),
                          ),
                          child: FittedBox(
                            fit: BoxFit.scaleDown,
                            child: Text(
                              _characterAt(lines[row], column),
                              style: AppTypography.lcdCharacter.copyWith(
                                color: foreground,
                              ),
                            ),
                          ),
                        ),
                      ),
                  ],
                ),
            ],
          ),
        ),
      ),
    );
  }
}

List<String> _normalizeLines(dynamic value) {
  final source =
      value is List ? value.map((item) => '$item').toList() : <String>[];
  return List.generate(
    _lcdRows,
    (index) =>
        index < source.length ? _truncate(source[index], _lcdColumns) : '',
    growable: false,
  );
}

String _truncate(String value, int limit) =>
    value.characters.take(limit).toString();

String _characterAt(String line, int column) {
  final characters = line.characters.toList(growable: false);
  return column < characters.length ? characters[column] : ' ';
}
