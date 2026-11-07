// Hallmark · safety page · is it safe? → incident actions → sensors → siren → activity
import 'package:flutter/material.dart';

import '../../../core/core.dart';
import '../../../core/widgets/widgets.dart';
import '../../../domain/models/device_model.dart';
import '../../dashboard/models/capability_model.dart';
import 'product_mini_cards.dart';
import 'product_page_kit.dart';

class HazardProductDetail extends StatefulWidget {
  const HazardProductDetail({
    super.key,
    required this.device,
    required this.onCapabilityChanged,
    this.activitySection,
  });

  final DeviceModel device;
  final ProductCapabilityChanged onCapabilityChanged;
  final Widget? activitySection;

  @override
  State<HazardProductDetail> createState() => _HazardProductDetailState();
}

class _HazardProductDetailState extends State<HazardProductDetail> {
  String? _pending;
  int _muteSeconds = 60;

  DeviceModel get _device => widget.device;

  CapabilityModel? _property(String capabilityId, String propertyId) =>
      productProperty(_device, capabilityId: capabilityId, propertyId: propertyId);

  Future<void> _run(CapabilityModel? capability, String key, dynamic value) async {
    if (capability == null || _pending != null) return;
    setState(() => _pending = key);
    try {
      await widget.onCapabilityChanged(capability, value);
    } finally {
      if (mounted) setState(() => _pending = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final risk = productText(_property('hazard_controller', 'risk_level'));
    final incident = _property('hazard_controller', 'incident_state');
    final incidentState = productText(incident);
    final incidentId = '${_property('hazard_controller', 'active_incident_id')?.value ?? ''}'.trim();
    final flame = _property('flame_detection', 'flame_detected');
    final flameDetected = flame?.value == true || productText(flame) == 'true';
    final siren = _property('alarm_siren', 'audible_state');
    final muteUntil = _property('alarm_siren', 'mute_until');
    final testSiren = _property('alarm_siren', 'test_siren');
    final tone = _riskTone(context, risk, flameDetected);
    final hasIncident = incidentId.isNotEmpty && (incidentState == 'active' || incidentState == 'acknowledged');

    return ProductPage(
      children: [
        ProductStatusHeader(
          device: _device,
          icon: tone == context.neu.deviceOnline ? Icons.verified_user_rounded : Icons.warning_rounded,
          status: _riskStatus(risk, flameDetected),
          detail: _riskDetail(risk, flameDetected, hasIncident),
          tone: tone,
        ),
        if (hasIncident)
          _IncidentCard(
            acknowledged: incidentState == 'acknowledged',
            pending: _pending,
            online: productOnline(_device),
            acknowledge: capabilityForOperation(incident, 'acknowledge_incident'),
            reset: capabilityForOperation(incident, 'reset_incident'),
            onAcknowledge: (capability) => _run(capability, 'ack', incidentId),
            onReset: (capability) => _run(capability, 'reset', incidentId),
          ),
        ProductReadingGrid(readings: _readings(context)),
        ProductSection(
          title: 'Còi báo động',
          child: _SirenCard(
            device: _device,
            siren: siren,
            muteUntil: muteUntil,
            testSiren: testSiren,
            pending: _pending,
            muteSeconds: _muteSeconds,
            onMuteSecondsChanged: (seconds) => setState(() => _muteSeconds = seconds),
            onRun: _run,
          ),
        ),
        if (widget.activitySection != null) widget.activitySection!,
      ],
    );
  }

  List<ProductReading> _readings(BuildContext context) {
    final alarm = context.colorScheme.error;
    String level(String capabilityId, String propertyId) {
      final value = _property(capabilityId, propertyId)?.value;
      return value is num ? '${value.round()}%' : '—';
    }

    String? warmUp(String capabilityId) =>
        productText(_property(capabilityId, 'calibration_state')) == 'warming_up' ? 'Đang khởi động cảm biến' : null;

    final flame = _property('flame_detection', 'flame_detected');
    final flameDetected = flame?.value == true || productText(flame) == 'true';
    final temperature = _property('temperature_measurement', 'temperature')?.value;
    final humidity = _property('humidity_measurement', 'humidity')?.value;
    return [
      ProductReading(
        icon: Icons.air_rounded,
        label: 'Khí gas',
        value: level('gas_measurement', 'gas_level'),
        caption: warmUp('gas_measurement'),
      ),
      ProductReading(
        icon: Icons.cloud_rounded,
        label: 'Khói',
        value: level('smoke_measurement', 'smoke_level'),
        caption: warmUp('smoke_measurement'),
      ),
      ProductReading(
        icon: Icons.local_fire_department_rounded,
        label: 'Lửa',
        value: flame?.value == null ? '—' : flameDetected ? 'Phát hiện' : 'Không có',
        tone: flameDetected ? alarm : null,
      ),
      ProductReading(
        icon: Icons.thermostat_rounded,
        label: 'Nhiệt độ',
        value: temperature is num ? '${temperature.toStringAsFixed(temperature % 1 == 0 ? 0 : 1)}°C' : '—',
      ),
      ProductReading(
        icon: Icons.water_drop_outlined,
        label: 'Độ ẩm',
        value: humidity is num ? '${humidity.round()}%' : '—',
      ),
    ];
  }
}

class _IncidentCard extends StatelessWidget {
  const _IncidentCard({
    required this.acknowledged,
    required this.pending,
    required this.online,
    required this.acknowledge,
    required this.reset,
    required this.onAcknowledge,
    required this.onReset,
  });

  final bool acknowledged;
  final String? pending;
  final bool online;
  final CapabilityModel? acknowledge;
  final CapabilityModel? reset;
  final ValueChanged<CapabilityModel> onAcknowledge;
  final ValueChanged<CapabilityModel> onReset;

  @override
  Widget build(BuildContext context) {
    final error = context.colorScheme.error;
    return NeuCard(
      color: Color.alphaBlend(error.withValues(alpha: 0.08), context.neu.surface),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              ProductToneIcon(icon: Icons.notification_important_rounded, tone: error),
              const SizedBox(width: AppSpacing.smMd),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      acknowledged ? 'Sự cố đã được xác nhận' : 'Sự cố đang diễn ra',
                      style: context.textTheme.titleMedium?.copyWith(color: error, fontWeight: FontWeight.w700),
                    ),
                    Text(
                      acknowledged
                          ? 'Kiểm tra khu vực bếp, sau đó kết thúc sự cố khi đã an toàn.'
                          : 'Hãy kiểm tra khu vực bếp ngay và xác nhận bạn đã biết.',
                      style: context.textTheme.bodySmall,
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.md),
          Wrap(
            spacing: AppSpacing.sm,
            runSpacing: AppSpacing.sm,
            alignment: WrapAlignment.end,
            children: [
              if (!acknowledged && acknowledge != null)
                FilledButton.icon(
                  style: FilledButton.styleFrom(backgroundColor: error, foregroundColor: context.colorScheme.onError),
                  onPressed: online && pending == null ? () => onAcknowledge(acknowledge!) : null,
                  icon: pending == 'ack' ? const ProductButtonSpinner() : const Icon(Icons.task_alt_rounded),
                  label: const Text('Tôi đã biết'),
                ),
              if (reset != null)
                OutlinedButton.icon(
                  onPressed: online && pending == null ? () => onReset(reset!) : null,
                  icon: pending == 'reset' ? const ProductButtonSpinner() : const Icon(Icons.verified_rounded),
                  label: const Text('Kết thúc sự cố'),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

class _SirenCard extends StatelessWidget {
  const _SirenCard({
    required this.device,
    required this.siren,
    required this.muteUntil,
    required this.testSiren,
    required this.pending,
    required this.muteSeconds,
    required this.onMuteSecondsChanged,
    required this.onRun,
  });

  final DeviceModel device;
  final CapabilityModel? siren;
  final CapabilityModel? muteUntil;
  /// Separate action entry: test_siren targets an event, not a property.
  final CapabilityModel? testSiren;
  final String? pending;
  final int muteSeconds;
  final ValueChanged<int> onMuteSecondsChanged;
  final Future<void> Function(CapabilityModel? capability, String key, dynamic value) onRun;

  List<int> _durations(CapabilityModel? mute) {
    const fallback = [60, 180, 300, 600, 1800];
    final schema = mute?.operations.single.inputSchema['duration_seconds'];
    if (schema is! Map) return fallback;
    final values = (schema['enum'] as List? ?? const [])
        .whereType<num>()
        .map((value) => value.toInt())
        .where((value) => value > 0)
        .toSet()
        .toList()
      ..sort();
    return values.isEmpty ? fallback : values;
  }

  @override
  Widget build(BuildContext context) {
    final state = productText(siren);
    final sounding = state == 'sounding';
    final muted = state == 'muted';
    final online = productOnline(device);
    final mute = capabilityForOperation(siren, 'mute_siren');
    final resume = capabilityForOperation(siren, 'resume_siren');
    final test = capabilityForOperation(testSiren, 'test_siren');
    final durations = _durations(mute);
    final selected = durations.contains(muteSeconds) ? muteSeconds : durations.first;
    final until = DateTime.tryParse('${muteUntil?.value ?? ''}');
    final tone = sounding
        ? context.colorScheme.error
        : muted
            ? context.neu.warningColor
            : context.colorScheme.primary;
    final idle = online && pending == null;

    return NeuCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              ProductToneIcon(
                icon: sounding
                    ? Icons.volume_up_rounded
                    : muted
                        ? Icons.volume_off_rounded
                        : Icons.notifications_none_rounded,
                tone: tone,
              ),
              const SizedBox(width: AppSpacing.smMd),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      sounding
                          ? 'Còi đang kêu'
                          : muted
                              ? 'Còi đang tạm tắt'
                              : 'Còi sẵn sàng',
                      style: context.textTheme.titleMedium?.copyWith(color: tone, fontWeight: FontWeight.w700),
                    ),
                    Text(
                      muted && until != null
                          ? 'Tự bật lại lúc ${productClock(until)}'
                          : sounding
                              ? 'Tắt còi không dừng việc giám sát'
                              : 'Còi tự kêu khi phát hiện nguy hiểm',
                      style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant),
                    ),
                  ],
                ),
              ),
            ],
          ),
          if (mute != null) ...[
            const SizedBox(height: AppSpacing.md),
            Text('Tắt còi trong', style: context.textTheme.labelMedium),
            const SizedBox(height: AppSpacing.sm),
            Wrap(
              spacing: AppSpacing.sm,
              runSpacing: AppSpacing.sm,
              children: [
                for (final seconds in durations)
                  ChoiceChip(
                    label: Text(productDurationLabel(seconds)),
                    selected: seconds == selected,
                    showCheckmark: false,
                    onSelected: idle ? (_) => onMuteSecondsChanged(seconds) : null,
                  ),
              ],
            ),
            const SizedBox(height: AppSpacing.md),
            OutlinedButton.icon(
              onPressed: idle ? () => onRun(mute, 'mute', selected) : null,
              icon: pending == 'mute' ? const ProductButtonSpinner() : const Icon(Icons.volume_off_rounded),
              label: Text(muted ? 'Đổi thời gian tắt còi' : 'Tắt còi tạm thời'),
            ),
          ],
          if (muted && resume != null) ...[
            const SizedBox(height: AppSpacing.sm),
            FilledButton.icon(
              onPressed: idle ? () => onRun(resume, 'resume', 'resume') : null,
              icon: pending == 'resume' ? const ProductButtonSpinner() : const Icon(Icons.notifications_active_rounded),
              label: const Text('Bật lại còi ngay'),
            ),
          ],
          if (test != null && !sounding) ...[
            const SizedBox(height: AppSpacing.xs),
            TextButton.icon(
              onPressed: idle ? () => onRun(test, 'test', 3) : null,
              icon: pending == 'test' ? const ProductButtonSpinner() : const Icon(Icons.campaign_outlined),
              label: const Text('Thử còi 3 giây'),
            ),
          ],
          if (!online) ...[
            const SizedBox(height: AppSpacing.sm),
            Text(
              'Thiết bị đang ngoại tuyến',
              textAlign: TextAlign.center,
              style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant),
            ),
          ],
        ],
      ),
    );
  }
}

Color _riskTone(BuildContext context, String risk, bool flame) {
  if (flame || risk == 'alarm' || risk == 'emergency') return context.colorScheme.error;
  if (risk == 'warning' || risk == 'sensor_fault') return context.neu.warningColor;
  return context.neu.deviceOnline;
}

String _riskStatus(String risk, bool flame) {
  if (flame) return 'Phát hiện lửa';
  return switch (risk) {
    'normal' => 'An toàn',
    'warning' => 'Cần chú ý',
    'alarm' => 'Báo động',
    'emergency' => 'Khẩn cấp',
    'sensor_fault' => 'Cảm biến gặp lỗi',
    _ => 'Đang kiểm tra',
  };
}

String _riskDetail(String risk, bool flame, bool incident) {
  if (incident) return 'Có sự cố cần bạn xử lý';
  if (flame) return 'Kiểm tra khu vực bếp ngay';
  return switch (risk) {
    'normal' => 'Gas, khói và lửa đều trong ngưỡng an toàn',
    'warning' => 'Một chỉ số đang tăng gần ngưỡng',
    'alarm' || 'emergency' => 'Nguy hiểm đang được phát hiện',
    'sensor_fault' => 'Một cảm biến không gửi được dữ liệu',
    _ => 'Đang chờ dữ liệu cảm biến',
  };
}
