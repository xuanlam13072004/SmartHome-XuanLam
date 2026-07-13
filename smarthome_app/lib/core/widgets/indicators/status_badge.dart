import 'package:flutter/material.dart';
import '../../core.dart';
import '../primitives/neu_container.dart';

/// Các loại trạng thái thiết bị
enum DeviceStatus {
  online,
  offline,
  pending,
  error,
}

/// Dấu hiệu trạng thái nhỏ gọn (StatusBadge).
class StatusBadge extends StatelessWidget {
  const StatusBadge({
    super.key,
    required this.status,
    this.size = 12.0,
  });

  final DeviceStatus status;
  final double size;

  Color _getColor(NeuColors neu) {
    switch (status) {
      case DeviceStatus.online:
        return neu.deviceOnline;
      case DeviceStatus.offline:
        return neu.deviceOffline;
      case DeviceStatus.pending:
        return neu.devicePending;
      case DeviceStatus.error:
        return neu.deviceError;
    }
  }

  @override
  Widget build(BuildContext context) {
    final neu = context.neu;
    final color = _getColor(neu);

    return NeuContainer(
      width: size,
      height: size,
      shape: BoxShape.circle,
      depth: NeuDepth.raisedSubtle,
      child: Center(
        child: Container(
          width: size * 0.6,
          height: size * 0.6,
          decoration: BoxDecoration(
            color: color,
            shape: BoxShape.circle,
            boxShadow: [
              BoxShadow(
                color: color.withValues(alpha: 0.5),
                blurRadius: 4,
                spreadRadius: 1,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
