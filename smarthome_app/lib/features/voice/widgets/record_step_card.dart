import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:lucide_icons/lucide_icons.dart';

import '../../../core/core.dart';
import '../../../core/widgets/widgets.dart';

/// One recording of a voice session: what to say (or to stay silent), the
/// record button with a live level meter, and the on-device check result.
class RecordStepCard extends StatelessWidget {
  const RecordStepCard({
    super.key,
    required this.index,
    required this.title,
    required this.instruction,
    required this.recording,
    required this.enabled,
    required this.onRecord,
    required this.onStop,
    this.sentence,
    this.levels,
    this.elapsed = Duration.zero,
    this.pcm,
    this.problem,
    this.summary,
    this.automatic = false,
  });

  final int index;
  final String title;
  final String instruction;
  final String? sentence;
  final bool recording;
  final bool enabled;
  final VoidCallback onRecord;
  final VoidCallback onStop;
  final Stream<double>? levels;
  final Duration elapsed;
  final Int16List? pcm;
  final String? problem;

  /// What the check measured (duration, noise) when the take is good.
  final String? summary;

  /// Stops by itself (the silence measurement).
  final bool automatic;

  bool get done => pcm != null && problem == null;

  @override
  Widget build(BuildContext context) {
    final scheme = context.colorScheme;
    final statusColor = problem != null
        ? scheme.error
        : done
            ? context.neu.successColor
            : scheme.onSurfaceVariant;
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.smMd),
      child: NeuCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                CircleAvatar(
                  radius: 13,
                  backgroundColor: statusColor.withValues(alpha: 0.15),
                  child: done
                      ? Icon(LucideIcons.check, size: 14, color: statusColor)
                      : Text('$index', style: TextStyle(fontSize: 12, color: statusColor)),
                ),
                const SizedBox(width: AppSpacing.sm),
                Expanded(child: Text(title, style: context.textTheme.titleSmall)),
              ],
            ),
            const SizedBox(height: AppSpacing.sm),
            Text(instruction, style: context.textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant)),
            if (sentence != null) ...[
              const SizedBox(height: AppSpacing.sm),
              Container(
                padding: const EdgeInsets.all(AppSpacing.smMd),
                decoration: BoxDecoration(
                  color: scheme.primary.withValues(alpha: 0.08),
                  borderRadius: BorderRadius.circular(AppRadius.sm),
                ),
                child: Text('“$sentence”', style: context.textTheme.titleMedium),
              ),
            ],
            const SizedBox(height: AppSpacing.smMd),
            if (recording)
              StreamBuilder<double>(
                stream: levels,
                builder: (context, snapshot) => Row(
                  children: [
                    Expanded(
                      child: ClipRRect(
                        borderRadius: BorderRadius.circular(4),
                        child: LinearProgressIndicator(value: snapshot.data ?? 0, minHeight: 8),
                      ),
                    ),
                    const SizedBox(width: AppSpacing.sm),
                    Text('${elapsed.inSeconds}s', style: context.textTheme.bodySmall),
                  ],
                ),
              )
            else if (problem != null)
              Row(
                children: [
                  Icon(LucideIcons.alertTriangle, size: 16, color: scheme.error),
                  const SizedBox(width: AppSpacing.xs),
                  Expanded(child: Text(problem!, style: TextStyle(color: scheme.error))),
                ],
              )
            else if (summary != null)
              Text(summary!, style: context.textTheme.bodySmall?.copyWith(color: context.neu.successColor)),
            const SizedBox(height: AppSpacing.sm),
            Align(
              alignment: Alignment.centerRight,
              child: recording
                  ? (automatic
                      ? const Text('Đang đo…')
                      : FilledButton.icon(
                          onPressed: onStop,
                          icon: const Icon(LucideIcons.square, size: 16),
                          label: const Text('Dừng'),
                        ))
                  : OutlinedButton.icon(
                      onPressed: enabled ? onRecord : null,
                      icon: Icon(pcm == null ? LucideIcons.mic : LucideIcons.rotateCcw, size: 16),
                      label: Text(pcm == null ? (automatic ? 'Bắt đầu đo' : 'Ghi âm') : 'Ghi lại'),
                    ),
            ),
          ],
        ),
      ),
    );
  }
}
