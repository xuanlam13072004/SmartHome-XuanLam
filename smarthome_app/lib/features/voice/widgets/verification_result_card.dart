import 'package:flutter/material.dart';
import 'package:lucide_icons/lucide_icons.dart';

import '../../../core/core.dart';
import '../../../core/widgets/widgets.dart';
import '../data/voice_models.dart';
import '../voice_texts.dart';

/// The outcome of "Thử giọng nói" with each score against its threshold.
class VerificationResultCard extends StatelessWidget {
  const VerificationResultCard({super.key, required this.result});

  final VoiceVerification result;

  @override
  Widget build(BuildContext context) {
    final color = result.accepted ? context.neu.successColor : context.colorScheme.error;
    final t = result.thresholds;
    final s = result.scores;
    return NeuCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Icon(result.accepted ? LucideIcons.checkCircle2 : LucideIcons.xCircle, color: color, size: 28),
              const SizedBox(width: AppSpacing.sm),
              Expanded(
                child: Text(
                  result.accepted ? 'Đúng là bạn' : VoiceTexts.reason(result.reason),
                  style: context.textTheme.titleMedium?.copyWith(color: color),
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.md),
          if (t.normalized && s.normalized != null)
            _ScoreRow(label: 'Độ nổi bật so với người lạ', value: s.normalized!, threshold: t.norm, max: 10)
          else
            _ScoreRow(label: 'Độ giống giọng đăng ký', value: s.similarity, threshold: t.speaker),
          if (t.antiSpoof != null)
            _ScoreRow(label: 'Giọng thật (chống giả mạo)', value: s.antiSpoof, threshold: t.antiSpoof!),
          _ScoreRow(label: 'Điểm tổng hợp', value: s.fusion, threshold: t.fusion),
          const SizedBox(height: AppSpacing.xs),
          Text(
            [
              'Độ sạch âm thanh ${s.snrDb.toStringAsFixed(0)} dB',
              if (result.galleryUpdated) 'đã học thêm từ lần nói này',
              if (!result.accepted && !result.lock.locked) 'còn ${result.lock.failuresLeft} lần thử trước khi tạm khóa',
              if (result.lock.locked) 'đã tạm khóa 15 phút',
            ].join(' · '),
            style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant),
          ),
        ],
      ),
    );
  }
}

class _ScoreRow extends StatelessWidget {
  const _ScoreRow({required this.label, required this.value, required this.threshold, this.max = 1});

  final String label;
  final double value;
  final double threshold;
  final double max;

  @override
  Widget build(BuildContext context) {
    final pass = value >= threshold;
    final color = pass ? context.neu.successColor : context.colorScheme.error;
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.sm),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(child: Text(label, style: context.textTheme.bodyMedium)),
              Text(
                '${value.toStringAsFixed(2)} / ${threshold.toStringAsFixed(2)}',
                style: context.textTheme.bodySmall?.copyWith(color: color, fontWeight: FontWeight.w600),
              ),
            ],
          ),
          const SizedBox(height: 4),
          LayoutBuilder(
            builder: (context, constraints) => Stack(
              children: [
                ClipRRect(
                  borderRadius: BorderRadius.circular(4),
                  child: LinearProgressIndicator(
                    value: (value / max).clamp(0.0, 1.0),
                    minHeight: 8,
                    color: color,
                    backgroundColor: color.withValues(alpha: 0.15),
                  ),
                ),
                Positioned(
                  left: (constraints.maxWidth * (threshold / max).clamp(0.0, 1.0)) - 1,
                  top: 0,
                  bottom: 0,
                  child: Container(width: 2, color: context.colorScheme.onSurface),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
