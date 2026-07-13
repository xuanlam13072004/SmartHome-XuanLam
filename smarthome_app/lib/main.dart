// lib/main.dart
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_localizations/flutter_localizations.dart';

import 'core/core.dart';
import 'core/widgets/widgets.dart'; // Import thư viện Widget vừa tạo

// ignore: depend_on_referenced_packages
import 'l10n/generated/app_localizations.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();

  SystemChrome.setSystemUIOverlayStyle(
    const SystemUiOverlayStyle(
      statusBarColor: Colors.transparent,
      statusBarIconBrightness: Brightness.dark,
      systemNavigationBarColor: Colors.transparent,
    ),
  );

  SystemChrome.setPreferredOrientations([
    DeviceOrientation.portraitUp,
    DeviceOrientation.portraitDown,
  ]);

  runApp(
    const ProviderScope(
      child: SmartHomeApp(),
    ),
  );
}

class SmartHomeApp extends ConsumerWidget {
  const SmartHomeApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return MaterialApp(
      title: 'SmartHome XuanLam',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light,
      darkTheme: AppTheme.dark,
      themeMode: ThemeMode.system,
      locale: const Locale('vi'),
      supportedLocales: AppL10n.supportedLocales,
      localizationsDelegates: const [
        AppL10n.delegate,
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      home: const _WidgetLibraryPreview(),
    );
  }
}

// ── Widget Library Preview ───────────────────────────────────────────────────

class _WidgetLibraryPreview extends StatefulWidget {
  const _WidgetLibraryPreview();

  @override
  State<_WidgetLibraryPreview> createState() => _WidgetLibraryPreviewState();
}

class _WidgetLibraryPreviewState extends State<_WidgetLibraryPreview> {
  // States cho control preview
  bool _toggleOn = true;
  double _sliderValue = 50.0;
  bool _chipSelected1 = true;
  bool _chipSelected2 = false;

  @override
  Widget build(BuildContext context) {
    return PageScaffold(
      appBar: AppBar(
        title: const Text('Widget Library Preview'),
      ),
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const SizedBox(height: AppSpacing.md),

          // ── Primitives ─────────────────────────────────────────────────────
          const SectionTitle(title: '1. Primitives'),
          NeuCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('NeuCard bọc nội dung'),
                const SizedBox(height: AppSpacing.md),
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceAround,
                  children: [
                    NeuIconBox(
                      icon: Icons.lightbulb_outline,
                      isActive: true,
                      iconColor: context.neu.categoryLight,
                    ),
                    const NeuIconBox(
                      icon: Icons.ac_unit,
                      isActive: false,
                    ),
                    const NeuIconBox(
                      icon: Icons.sensors,
                      isActive: false,
                      shape: BoxShape.circle,
                    ),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(height: AppSpacing.md),

          // ── Controls ───────────────────────────────────────────────────────
          const SectionTitle(title: '2. Controls'),
          NeuCard(
            child: Column(
              children: [
                Row(
                  children: [
                    Expanded(
                      child: NeuButton.text(
                        'Normal Button',
                        onPressed: () {},
                      ),
                    ),
                    const SizedBox(width: AppSpacing.md),
                    NeuButton.icon(
                      Icons.power_settings_new,
                      onPressed: () {},
                    ),
                  ],
                ),
                const SizedBox(height: AppSpacing.md),
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    const Text('Disabled Button'),
                    NeuButton.text(
                      'Disabled',
                      isDisabled: true,
                      onPressed: () {},
                    ),
                  ],
                ),
                const SizedBox(height: AppSpacing.md),
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    const Text('NeuToggle'),
                    NeuToggle(
                      value: _toggleOn,
                      onChanged: (val) => setState(() => _toggleOn = val),
                    ),
                  ],
                ),
                const SizedBox(height: AppSpacing.md),
                NeuSlider(
                  value: _sliderValue,
                  onChanged: (val) => setState(() => _sliderValue = val),
                ),
                const SizedBox(height: AppSpacing.md),
                Row(
                  children: [
                    NeuChip(
                      label: 'Phòng khách',
                      isSelected: _chipSelected1,
                      onSelected: (val) => setState(() => _chipSelected1 = val),
                    ),
                    const SizedBox(width: AppSpacing.sm),
                    NeuChip(
                      label: 'Phòng ngủ',
                      isSelected: _chipSelected2,
                      onSelected: (val) => setState(() => _chipSelected2 = val),
                    ),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(height: AppSpacing.md),

          // ── Indicators ─────────────────────────────────────────────────────
          const SectionTitle(title: '3. Indicators'),
          const NeuCard(
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceAround,
              children: [
                StatusBadge(status: DeviceStatus.online),
                StatusBadge(status: DeviceStatus.offline),
                StatusBadge(status: DeviceStatus.pending),
                StatusBadge(status: DeviceStatus.error),
                SizedBox(width: AppSpacing.md),
                LoadingIndicator(size: 32),
              ],
            ),
          ),
          const SizedBox(height: AppSpacing.md),

          // ── Cards ──────────────────────────────────────────────────────────
          const SectionTitle(title: '4. Cards'),
          DeviceCard(
            title: 'Đèn trần phòng khách',
            subtitle: 'Đang hoạt động',
            icon: Icons.lightbulb,
            status: DeviceStatus.online,
            iconColor: context.neu.categoryLight,
            actionWidget: NeuToggle(
              value: true,
              onChanged: (_) {},
              width: 50,
              height: 28,
            ),
          ),
          const SizedBox(height: AppSpacing.md),
          const DeviceCard(
            title: 'Điều hòa phòng ngủ',
            subtitle: 'Mất kết nối',
            icon: Icons.ac_unit,
            status: DeviceStatus.offline,
          ),
          const SizedBox(height: AppSpacing.md),

          // ── Layouts ────────────────────────────────────────────────────────
          const SectionTitle(title: '5. Layouts (EmptyState)'),
          NeuCard(
            child: EmptyState(
              icon: Icons.devices_other,
              title: 'Chưa có thiết bị',
              description: 'Hãy thêm thiết bị mới vào phòng này.',
              actionText: 'Thêm thiết bị',
              onActionTap: () {},
            ),
          ),

          const SizedBox(height: AppSpacing.xxl),
        ],
      ),
    );
  }
}
