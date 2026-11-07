import 'package:flutter/material.dart';

import '../../../core/core.dart';
import '../../../domain/models/device_model.dart';
import '../../products/widgets/product_mini_cards.dart';
import '../camera_labels.dart';
import '../presentation/camera_viewer_panel.dart';

class SecurityCameraMiniCard extends StatelessWidget {
  const SecurityCameraMiniCard({super.key, required this.device, required this.onTap});

  final DeviceModel device;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final hasImage = device.cameraHasImage;
    final recording = '${device.cameraValue('recording_state')}' == 'recording';
    return ProductMiniCardFrame(
      device: device,
      onTap: onTap,
      showConnection: false,
      icon: hasImage ? Icons.videocam_rounded : Icons.videocam_off_rounded,
      eyebrow: 'CAMERA',
      statusLabel: device.cameraStateLabel,
      accent: hasImage ? context.colorScheme.primary : context.colorScheme.onSurfaceVariant,
      metrics: [
        ProductMiniMetric(
          icon: recording ? Icons.fiber_manual_record_rounded : Icons.stop_circle_outlined,
          label: 'Ghi hình',
          value: device.recordingStateLabel,
        ),
        ProductMiniMetric(
          icon: Icons.sd_storage_rounded,
          label: 'Bộ nhớ',
          value: device.storageSummary,
        ),
      ],
    );
  }
}

/// Camera page: the video and its timeline are the page (no hero, no
/// Hub–Node panel, no diagnostics; a camera never joins Hub–Node).
class SecurityCameraProductDetail extends StatelessWidget {
  const SecurityCameraProductDetail({super.key, required this.device});

  final DeviceModel device;

  @override
  Widget build(BuildContext context) => CameraViewerPanel(device: device);
}
