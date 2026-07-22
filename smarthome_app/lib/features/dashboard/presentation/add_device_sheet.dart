import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons/lucide_icons.dart';
import '../../../core/core.dart';
import '../../../core/utils/app_error_mapper.dart';
import '../../../core/widgets/widgets.dart';
import '../providers/devices_provider.dart';

class AddDeviceSheet extends ConsumerStatefulWidget {
  const AddDeviceSheet({
    super.key,
    this.initialMac,
    this.initialSecret,
  });

  final String? initialMac;
  final String? initialSecret;

  @override
  ConsumerState<AddDeviceSheet> createState() => _AddDeviceSheetState();
}

class _AddDeviceSheetState extends ConsumerState<AddDeviceSheet> {
  late final TextEditingController _macController;
  late final TextEditingController _secretKeyController;
  final _nameController = TextEditingController();

  bool _isLoading = false;
  String? _errorMsg;

  @override
  void initState() {
    super.initState();
    _macController = TextEditingController(text: widget.initialMac);
    _secretKeyController = TextEditingController(text: widget.initialSecret);
  }

  @override
  void dispose() {
    _macController.dispose();
    _secretKeyController.dispose();
    _nameController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final mac = _macController.text.trim().toUpperCase();
    final secret = _secretKeyController.text.trim();
    final name = _nameController.text.trim();

    if (mac.isEmpty || secret.isEmpty) {
      setState(() {
        _errorMsg = 'Vui lòng nhập MAC Address và Mã xác thực';
      });
      return;
    }

    final macRegex = RegExp(r'^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$');
    if (!macRegex.hasMatch(mac)) {
      setState(() {
        _errorMsg = 'MAC Address không hợp lệ (VD: AA:BB:CC:DD:EE:FF)';
      });
      return;
    }

    setState(() {
      _isLoading = true;
      _errorMsg = null;
    });

    try {
      await ref.read(devicesProvider.notifier).claimDevice(
            mac,
            secret,
            name: name.isNotEmpty ? name : null,
          );

      if (!mounted) return;
      context.pop(true);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _errorMsg = AppErrorMapper.mapError(e);
      });
    } finally {
      if (mounted) {
        setState(() {
          _isLoading = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    // Để bottom sheet bo viền và tránh bị che bởi keyboard
    return Container(
      decoration: BoxDecoration(
        color: context.colorScheme.surface,
        borderRadius:
            const BorderRadius.vertical(top: Radius.circular(AppRadius.xl)),
      ),
      padding: EdgeInsets.only(
        left: AppSpacing.lg,
        right: AppSpacing.lg,
        top: AppSpacing.lg,
        bottom: MediaQuery.of(context).viewInsets.bottom + AppSpacing.xl,
      ),
      child: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Center(
              child: Container(
                width: 40,
                height: 4,
                margin: const EdgeInsets.only(bottom: AppSpacing.xl),
                decoration: BoxDecoration(
                  color: context.colorScheme.outlineVariant,
                  borderRadius: BorderRadius.circular(AppRadius.full),
                ),
              ),
            ),
            Row(
              children: [
                Icon(LucideIcons.plugZap,
                    color: context.colorScheme.primary, size: 28),
                const SizedBox(width: AppSpacing.md),
                Text(
                  'Thêm thiết bị mới',
                  style: context.textTheme.titleLarge?.copyWith(
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.xl),
            _buildTextField(
              context: context,
              controller: _macController,
              label: 'MAC Address',
              hintText: 'AA:BB:CC:DD:EE:FF',
              prefixIcon: LucideIcons.cpu,
              readOnly: widget.initialMac != null,
            ),
            const SizedBox(height: AppSpacing.md),
            _buildTextField(
              context: context,
              controller: _secretKeyController,
              label: 'Mã xác thực (Secret Key)',
              hintText: 'Nhập mã được in trên thiết bị',
              prefixIcon: LucideIcons.key,
              obscureText: true,
              readOnly: widget.initialSecret != null,
            ),
            const SizedBox(height: AppSpacing.md),
            _buildTextField(
              context: context,
              controller: _nameController,
              label: 'Tên thiết bị (Tùy chọn)',
              hintText: 'VD: Đèn phòng khách',
              prefixIcon: LucideIcons.type,
            ),
            if (_errorMsg != null) ...[
              const SizedBox(height: AppSpacing.md),
              Text(
                _errorMsg!,
                style: context.textTheme.bodySmall?.copyWith(
                  color: context.colorScheme.error,
                  fontWeight: FontWeight.bold,
                ),
              ),
            ],
            const SizedBox(height: AppSpacing.xl),
            SizedBox(
              width: double.infinity,
              child: NeuButton(
                onPressed: _isLoading ? () {} : _submit,
                child: _isLoading
                    ? const SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Text('Kết nối'),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildTextField({
    required BuildContext context,
    required TextEditingController controller,
    required String label,
    required String hintText,
    required IconData prefixIcon,
    bool obscureText = false,
    bool readOnly = false,
  }) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: context.textTheme.labelLarge?.copyWith(
            fontWeight: FontWeight.bold,
            color: readOnly ? context.colorScheme.onSurfaceVariant : null,
          ),
        ),
        const SizedBox(height: AppSpacing.xs),
        TextField(
          controller: controller,
          obscureText: obscureText,
          readOnly: readOnly,
          style: TextStyle(
            color: readOnly ? context.colorScheme.onSurfaceVariant : null,
          ),
          decoration: InputDecoration(
            hintText: hintText,
            prefixIcon: Icon(prefixIcon, color: context.colorScheme.primary),
            filled: true,
            fillColor: context.colorScheme.surfaceContainerHighest
                .withValues(alpha: 0.3),
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(AppRadius.md),
              borderSide: BorderSide.none,
            ),
            focusedBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(AppRadius.md),
              borderSide:
                  BorderSide(color: context.colorScheme.primary, width: 2),
            ),
          ),
        ),
      ],
    );
  }
}
