import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import '../../../core/core.dart';
import 'add_device_sheet.dart';

class QRScannerScreen extends StatefulWidget {
  const QRScannerScreen({super.key});

  @override
  State<QRScannerScreen> createState() => _QRScannerScreenState();
}

class _QRScannerScreenState extends State<QRScannerScreen> {
  final MobileScannerController _scannerController = MobileScannerController();
  bool _isProcessing = false;

  @override
  void dispose() {
    _scannerController.dispose();
    super.dispose();
  }

  void _onDetect(BarcodeCapture capture) {
    if (_isProcessing) return;

    final List<Barcode> barcodes = capture.barcodes;
    if (barcodes.isEmpty) return;

    final barcode = barcodes.first;
    if (barcode.rawValue != null) {
      _processQRData(barcode.rawValue!);
    }
  }

  void _processQRData(String rawData) {
    setState(() => _isProcessing = true);

    try {
      final data = jsonDecode(rawData) as Map<String, dynamic>;
      
      final mac = data['mac'] as String?;
      final secret = data['secret'] as String?; // Hoặc secret_key tùy lúc tạo mã

      if (mac != null && secret != null) {
        _scannerController.stop();
        // Mở Form xác nhận
        _openConfirmationSheet(mac, secret);
        return;
      }
    } catch (e) {
      // Ignored: JSON parse error
    }

    // Nếu mã sai định dạng, hiển thị lỗi và cho phép quét lại
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: const Text('Mã QR không đúng định dạng thiết bị'),
        backgroundColor: context.colorScheme.error,
        duration: const Duration(seconds: 2),
      ),
    );
    
    // Đợi 2s rồi cho quét tiếp
    Future.delayed(const Duration(seconds: 2), () {
      if (mounted) setState(() => _isProcessing = false);
    });
  }

  void _openConfirmationSheet(String mac, String secret) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (context) => AddDeviceSheet(
        initialMac: mac,
        initialSecret: secret,
      ),
    ).then((_) {
      // Khi đóng bottom sheet (bấm ngoài hoặc Hủy), nếu vẫn ở màn hình này thì resume camera
      if (mounted) {
        _scannerController.start();
        setState(() => _isProcessing = false);
      }
    });
  }

  void _openManualEntry() {
    _scannerController.stop();
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (context) => const AddDeviceSheet(),
    ).then((_) {
      if (mounted) {
        _scannerController.start();
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      body: Stack(
        children: [
          // Camera
          MobileScanner(
            controller: _scannerController,
            onDetect: _onDetect,
          ),

          // Overlay làm mờ
          Container(
            decoration: ShapeDecoration(
              shape: QROverlayShape(
                borderColor: context.colorScheme.primary,
                borderRadius: 12,
                borderLength: 40,
                borderWidth: 8,
                cutOutSize: MediaQuery.of(context).size.width * 0.7,
                overlayColor: Colors.black54,
              ),
            ),
          ),

          // Nút Back & Flash
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(AppSpacing.md),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  IconButton(
                    icon: const Icon(Icons.arrow_back, color: Colors.white, size: 28),
                    onPressed: () => context.pop(),
                  ),
                  IconButton(
                    icon: ValueListenableBuilder(
                      valueListenable: _scannerController,
                      builder: (context, state, child) {
                        switch (state.torchState) {
                          case TorchState.on:
                            return const Icon(LucideIcons.flashlight, color: Colors.yellow, size: 28);
                          case TorchState.off:
                          case TorchState.auto:
                          case TorchState.unavailable:
                            return const Icon(LucideIcons.flashlightOff, color: Colors.white, size: 28);
                        }
                      },
                    ),
                    onPressed: () => _scannerController.toggleTorch(),
                  ),
                ],
              ),
            ),
          ),

          // Hướng dẫn
          Positioned(
            bottom: 120,
            left: 0,
            right: 0,
            child: Center(
              child: Text(
                'Hướng camera vào mã QR\ntrên thiết bị để kết nối',
                textAlign: TextAlign.center,
                style: context.textTheme.titleMedium?.copyWith(
                  color: Colors.white,
                  fontWeight: FontWeight.w500,
                  shadows: [
                    const Shadow(
                      color: Colors.black87,
                      blurRadius: 4,
                    )
                  ]
                ),
              ),
            ),
          ),

          // Nút Nhập thủ công
          Positioned(
            bottom: 40,
            left: 0,
            right: 0,
            child: Center(
              child: TextButton.icon(
                onPressed: _openManualEntry,
                icon: const Icon(LucideIcons.keyboard, color: Colors.white),
                label: const Text(
                  'Nhập mã thủ công',
                  style: TextStyle(color: Colors.white, fontSize: 16),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Custom Shape cho khung ngắm QR
class QROverlayShape extends ShapeBorder {
  const QROverlayShape({
    this.borderColor = Colors.red,
    this.borderWidth = 3.0,
    this.overlayColor = const Color.fromRGBO(0, 0, 0, 80),
    this.borderRadius = 0,
    this.borderLength = 40,
    this.cutOutSize = 250,
  });

  final Color borderColor;
  final double borderWidth;
  final Color overlayColor;
  final double borderRadius;
  final double borderLength;
  final double cutOutSize;

  @override
  EdgeInsetsGeometry get dimensions => const EdgeInsets.all(10);

  @override
  Path getInnerPath(Rect rect, {TextDirection? textDirection}) {
    return Path()
      ..fillType = PathFillType.evenOdd
      ..addPath(getOuterPath(rect), Offset.zero);
  }

  @override
  Path getOuterPath(Rect rect, {TextDirection? textDirection}) {
    Path path = Path();
    path.addRect(rect);

    double cutoutX = (rect.width - cutOutSize) / 2;
    double cutoutY = (rect.height - cutOutSize) / 2;

    path.addRRect(
      RRect.fromRectAndRadius(
        Rect.fromLTWH(cutoutX, cutoutY, cutOutSize, cutOutSize),
        Radius.circular(borderRadius),
      ),
    );

    return path;
  }

  @override
  void paint(Canvas canvas, Rect rect, {TextDirection? textDirection}) {
    final width = rect.width;
    final borderWidthSize = width / 2;
    final borderLengthSize = borderLength > cutOutSize / 2 + borderWidthSize ? borderWidthSize / 2 : borderLength;

    double cutoutX = (rect.width - cutOutSize) / 2;
    double cutoutY = (rect.height - cutOutSize) / 2;

    final paint = Paint()
      ..color = overlayColor
      ..style = PaintingStyle.fill;
    
    // Draw background
    canvas.drawPath(getOuterPath(rect), paint);

    final borderPaint = Paint()
      ..color = borderColor
      ..style = PaintingStyle.stroke
      ..strokeWidth = borderWidth;

    // Vẽ 4 góc
    final path = Path();
    // Góc trên trái
    path.moveTo(cutoutX, cutoutY + borderLengthSize);
    path.lineTo(cutoutX, cutoutY + borderRadius);
    path.quadraticBezierTo(cutoutX, cutoutY, cutoutX + borderRadius, cutoutY);
    path.lineTo(cutoutX + borderLengthSize, cutoutY);
    
    // Góc trên phải
    path.moveTo(cutoutX + cutOutSize - borderLengthSize, cutoutY);
    path.lineTo(cutoutX + cutOutSize - borderRadius, cutoutY);
    path.quadraticBezierTo(cutoutX + cutOutSize, cutoutY, cutoutX + cutOutSize, cutoutY + borderRadius);
    path.lineTo(cutoutX + cutOutSize, cutoutY + borderLengthSize);

    // Góc dưới trái
    path.moveTo(cutoutX, cutoutY + cutOutSize - borderLengthSize);
    path.lineTo(cutoutX, cutoutY + cutOutSize - borderRadius);
    path.quadraticBezierTo(cutoutX, cutoutY + cutOutSize, cutoutX + borderRadius, cutoutY + cutOutSize);
    path.lineTo(cutoutX + borderLengthSize, cutoutY + cutOutSize);

    // Góc dưới phải
    path.moveTo(cutoutX + cutOutSize - borderLengthSize, cutoutY + cutOutSize);
    path.lineTo(cutoutX + cutOutSize - borderRadius, cutoutY + cutOutSize);
    path.quadraticBezierTo(cutoutX + cutOutSize, cutoutY + cutOutSize, cutoutX + cutOutSize, cutoutY + cutOutSize - borderRadius);
    path.lineTo(cutoutX + cutOutSize, cutoutY + cutOutSize - borderLengthSize);

    canvas.drawPath(path, borderPaint);
  }

  @override
  ShapeBorder scale(double t) {
    return QROverlayShape(
      borderColor: borderColor,
      borderWidth: borderWidth * t,
      overlayColor: overlayColor,
      borderRadius: borderRadius * t,
      borderLength: borderLength * t,
      cutOutSize: cutOutSize * t,
    );
  }
}
