// Hallmark · entrance page · lock state → one big lock button → door & PIN → settings → history
import 'package:flutter/material.dart';

import '../../../core/core.dart';
import '../../../core/widgets/widgets.dart';
import '../../../domain/models/device_model.dart';
import '../../../domain/models/product_model.dart';
import '../../dashboard/models/capability_model.dart';
import 'entrance_lcd_panel.dart';
import 'product_mini_cards.dart';
import 'product_page_kit.dart';

class EntranceProductDetail extends StatelessWidget {
  const EntranceProductDetail({
    super.key,
    required this.device,
    required this.onCapabilityChanged,
    this.onReplaceCredential,
    this.activitySection,
  });

  final DeviceModel device;
  final ProductCapabilityChanged onCapabilityChanged;
  final Future<void> Function(DeviceCredentialDefinition credential)? onReplaceCredential;
  final Widget? activitySection;

  @override
  Widget build(BuildContext context) {
    final lock = productProperty(device, capabilityId: 'door_lock', propertyId: 'lock_state');
    final door = productProperty(device, capabilityId: 'door_position', propertyId: 'door_state');
    final doorSensor = productProperty(device, capabilityId: 'door_position', propertyId: 'position_sensor_state');
    final pinConfigured = productProperty(device, capabilityId: 'pin_authentication', propertyId: 'pin_configured');
    final lcdLines = productProperty(device, capabilityId: 'character_display_4x20', propertyId: 'displayed_lines');
    final lcdSource = productProperty(device, capabilityId: 'character_display_4x20', propertyId: 'display_source');
    final pin = device.credentials.where((item) => item.definition.kind == 'pin').firstOrNull;
    final lockState = productText(lock);
    final locked = lockState == 'locked';
    final fault = lockState == 'fault';
    final doorState = productText(door);

    final settings = <Widget>[
      if (pin != null && onReplaceCredential != null)
        ProductSettingTile(
          icon: Icons.password_rounded,
          title: 'Mã PIN mở cửa',
          subtitle: 'Đổi mã dùng trên bàn phím cửa',
          enabled: productOnline(device),
          onTap: () => onReplaceCredential!(pin),
        ),
      if (lcdLines != null)
        ProductSettingTile(
          icon: Icons.chat_bubble_outline_rounded,
          title: 'Lời nhắn trên màn hình cửa',
          subtitle: productText(lcdSource) == 'custom' ? 'Đang hiện lời nhắn của bạn' : 'Đang hiện nội dung mặc định',
          onTap: () => _openLcdSheet(context, lcdLines, lcdSource),
        ),
    ];

    return ProductPage(
      children: [
        ProductStatusHeader(
          device: device,
          icon: locked ? Icons.lock_rounded : fault ? Icons.error_outline_rounded : Icons.lock_open_rounded,
          status: _lockStatus(lockState),
          detail: _doorDetail(doorState, productText(doorSensor)),
          tone: fault
              ? context.colorScheme.error
              : locked
                  ? context.colorScheme.primary
                  : context.neu.warningColor,
        ),
        NeuCard(
          padding: const EdgeInsets.symmetric(vertical: AppSpacing.xl, horizontal: AppSpacing.md),
          child: _LockControl(
            device: device,
            lock: lock,
            onCapabilityChanged: onCapabilityChanged,
          ),
        ),
        ProductReadingGrid(
          readings: [
            ProductReading(
              icon: Icons.door_front_door_rounded,
              label: 'Cửa',
              value: _doorLabel(doorState),
              tone: doorState == 'open' ? context.neu.warningColor : null,
              caption: productText(doorSensor) == 'fault' ? 'Cảm biến cửa lỗi' : null,
            ),
            ProductReading(
              icon: Icons.dialpad_rounded,
              label: 'Mã PIN',
              value: pinConfigured?.value == true ? 'Đã cài đặt' : 'Chưa cài đặt',
              tone: pinConfigured?.value == true ? null : context.neu.warningColor,
            ),
          ],
        ),
        if (settings.isNotEmpty) ProductSection(title: 'Cài đặt', child: ProductSettingsCard(children: settings)),
        if (activitySection != null) activitySection!,
      ],
    );
  }

  void _openLcdSheet(BuildContext context, CapabilityModel lines, CapabilityModel? source) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (sheetContext) => Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(sheetContext).bottom),
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, AppSpacing.lg),
          child: EntranceLcdPanel(
            linesCapability: lines,
            sourceCapability: source,
            deviceOnline: productOnline(device),
            onCapabilityChanged: onCapabilityChanged,
          ),
        ),
      ),
    );
  }
}

class _LockControl extends StatefulWidget {
  const _LockControl({required this.device, required this.lock, required this.onCapabilityChanged});

  final DeviceModel device;
  final CapabilityModel? lock;
  final ProductCapabilityChanged onCapabilityChanged;

  @override
  State<_LockControl> createState() => _LockControlState();
}

class _LockControlState extends State<_LockControl> {
  bool _sending = false;

  Future<void> _toggle(bool locked) async {
    final operation = locked ? 'unlock' : 'lock';
    final capability = capabilityForOperation(widget.lock, operation);
    if (capability == null || _sending) return;
    setState(() => _sending = true);
    try {
      await widget.onCapabilityChanged(capability, locked ? 'unlocking' : 'locking');
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = productText(widget.lock);
    final locked = state == 'locked';
    final moving = state == 'locking' || state == 'unlocking';
    final online = productOnline(widget.device);
    final allowed = capabilityForOperation(widget.lock, locked ? 'unlock' : 'lock') != null;
    final tone = locked ? context.colorScheme.primary : context.neu.warningColor;
    String? caption;
    if (!online) {
      caption = 'Thiết bị đang ngoại tuyến';
    } else if (!allowed) {
      caption = 'Bạn không có quyền điều khiển khóa';
    } else if (moving) {
      caption = state == 'locking' ? 'Đang khóa cửa…' : 'Đang mở khóa…';
    } else {
      caption = locked ? 'Cửa đang khóa an toàn' : 'Cửa đang mở khóa';
    }
    return ProductPrimaryControl(
      icon: locked ? Icons.lock_rounded : Icons.lock_open_rounded,
      label: locked ? 'Mở khóa' : 'Khóa cửa',
      caption: caption,
      tone: tone,
      active: !locked,
      busy: _sending || moving,
      onPressed: online && allowed && state != 'fault' ? () => _toggle(locked) : null,
    );
  }
}

String _lockStatus(String state) => switch (state) {
      'locked' => 'Đã khóa',
      'unlocked' => 'Đã mở khóa',
      'locking' => 'Đang khóa…',
      'unlocking' => 'Đang mở khóa…',
      'fault' => 'Khóa gặp lỗi',
      _ => 'Chưa rõ trạng thái',
    };

String _doorLabel(String state) => switch (state) {
      'closed' => 'Đang đóng',
      'open' => 'Đang mở',
      'opening' => 'Đang mở ra',
      'closing' => 'Đang đóng lại',
      _ => 'Chưa rõ',
    };

String _doorDetail(String door, String sensor) {
  if (sensor == 'fault') return 'Cảm biến cửa cần được kiểm tra';
  return switch (door) {
    'closed' => 'Cửa đang đóng',
    'open' => 'Cửa đang mở',
    'opening' || 'closing' => 'Cửa đang chuyển động',
    _ => 'Chưa có dữ liệu cửa',
  };
}
