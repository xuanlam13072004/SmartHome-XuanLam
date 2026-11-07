// Hallmark · roof page · roof state → open / close → weather → automatic mode → activity
import 'package:flutter/material.dart';

import '../../../core/core.dart';
import '../../../core/widgets/widgets.dart';
import '../../../domain/models/device_model.dart';
import '../../dashboard/models/capability_model.dart';
import 'product_mini_cards.dart';
import 'product_page_kit.dart';

class RoofProductDetail extends StatefulWidget {
  const RoofProductDetail({
    super.key,
    required this.device,
    required this.onCapabilityChanged,
    this.activitySection,
  });

  final DeviceModel device;
  final ProductCapabilityChanged onCapabilityChanged;
  final Widget? activitySection;

  @override
  State<RoofProductDetail> createState() => _RoofProductDetailState();
}

class _RoofProductDetailState extends State<RoofProductDetail> {
  String? _pending;

  DeviceModel get _device => widget.device;

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
    final movement = productProperty(_device, capabilityId: 'cover_controller', propertyId: 'movement');
    final rain = productProperty(_device, capabilityId: 'rain_detection', propertyId: 'rain_detected');
    final mode = productProperty(_device, capabilityId: 'roof_policy', propertyId: 'control_mode');
    final state = productText(movement);
    final raining = rain?.value == true || productText(rain) == 'true';
    final automatic = productText(mode) == 'automatic';
    final online = productOnline(_device);
    final open = capabilityForOperation(movement, 'open');
    final close = capabilityForOperation(movement, 'close');
    final setMode = capabilityForOperation(mode, 'set_control_mode');
    final opened = state == 'open' || state == 'opening';
    final rainTone = context.colorScheme.secondary;

    return ProductPage(
      children: [
        ProductStatusHeader(
          device: _device,
          icon: Icons.roofing_rounded,
          status: _roofStatus(state),
          detail: [
            raining ? 'Đang mưa' : 'Trời khô ráo',
            automatic ? 'Tự động theo mưa' : 'Điều khiển thủ công',
          ].join(' · '),
          tone: state == 'opening' || state == 'closing' ? context.neu.warningColor : null,
        ),
        NeuCard(
          padding: const EdgeInsets.all(AppSpacing.md),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Expanded(
                    child: ProductActionTile(
                      icon: Icons.unfold_more_rounded,
                      label: 'Mở mái',
                      tone: context.colorScheme.primary,
                      active: opened,
                      busy: _pending == 'open' || state == 'opening',
                      onPressed: online && open != null && state != 'open'
                          ? () => _run(open, 'open', 'opening')
                          : null,
                    ),
                  ),
                  const SizedBox(width: AppSpacing.smMd),
                  Expanded(
                    child: ProductActionTile(
                      icon: Icons.unfold_less_rounded,
                      label: 'Đóng mái',
                      tone: context.colorScheme.primary,
                      active: !opened && state.isNotEmpty,
                      busy: _pending == 'close' || state == 'closing',
                      onPressed: online && close != null && state != 'closed'
                          ? () => _run(close, 'close', 'closing')
                          : null,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: AppSpacing.smMd),
              Text(
                _motionHint(state, online: online, allowed: open != null && close != null, raining: raining),
                textAlign: TextAlign.center,
                style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant),
              ),
            ],
          ),
        ),
        ProductReadingGrid(
          readings: [
            ProductReading(
              icon: raining ? Icons.water_drop_rounded : Icons.wb_sunny_rounded,
              label: 'Thời tiết',
              value: raining ? 'Đang mưa' : 'Khô ráo',
              tone: raining ? rainTone : null,
            ),
            ProductReading(
              icon: automatic ? Icons.auto_mode_rounded : Icons.touch_app_rounded,
              label: 'Chế độ',
              value: automatic ? 'Tự động' : 'Thủ công',
            ),
          ],
        ),
        ProductSection(
          title: 'Cài đặt',
          child: ProductSettingsCard(
            children: [
              ProductSettingTile(
                icon: Icons.auto_mode_rounded,
                title: 'Tự động đóng khi mưa',
                subtitle: automatic
                    ? 'Mái tự xử lý theo cảm biến mưa'
                    : 'Bạn chủ động mở và đóng mái',
                enabled: online && setMode != null,
                trailing: _pending == 'mode'
                    ? const ProductButtonSpinner()
                    : Switch(
                        value: automatic,
                        onChanged: online && setMode != null && _pending == null
                            ? (value) => _run(setMode, 'mode', value ? 'automatic' : 'manual')
                            : null,
                      ),
              ),
            ],
          ),
        ),
        if (widget.activitySection != null) widget.activitySection!,
      ],
    );
  }
}

String _roofStatus(String state) => switch (state) {
      'open' => 'Mái đang mở',
      'closed' => 'Mái đã đóng',
      'opening' => 'Đang mở mái…',
      'closing' => 'Đang đóng mái…',
      _ => 'Chưa rõ trạng thái',
    };

String _motionHint(String state, {required bool online, required bool allowed, required bool raining}) {
  if (!online) return 'Thiết bị đang ngoại tuyến';
  if (!allowed) return 'Bạn không có quyền điều khiển mái';
  return switch (state) {
    'opening' => 'Mái đang mở; có thể bấm Đóng mái để đổi chiều',
    'closing' => 'Mái đang đóng; có thể bấm Mở mái để đổi chiều',
    'open' => raining ? 'Trời đang mưa, nên đóng mái' : 'Mái đang mở hoàn toàn',
    'closed' => 'Mái đang đóng hoàn toàn',
    _ => 'Chọn Mở mái hoặc Đóng mái',
  };
}
