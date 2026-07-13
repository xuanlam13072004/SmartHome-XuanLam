// lib/main.dart
//
// Entry point của ứng dụng SmartHome XuanLam.
// Phase 1: Khởi tạo Riverpod ProviderScope, theme, và l10n.
// Hiển thị Design System Preview để verify token/theme hoạt động.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_localizations/flutter_localizations.dart';

import 'core/core.dart';

// l10n generated — chạy `flutter gen-l10n` để tạo file này
// ignore: depend_on_referenced_packages
import 'l10n/generated/app_localizations.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();

  // Cấu hình status bar transparent để UI tràn lên
  SystemChrome.setSystemUIOverlayStyle(
    const SystemUiOverlayStyle(
      statusBarColor: Colors.transparent,
      statusBarIconBrightness: Brightness.dark,
      systemNavigationBarColor: Colors.transparent,
    ),
  );

  // Chỉ cho phép portrait
  SystemChrome.setPreferredOrientations([
    DeviceOrientation.portraitUp,
    DeviceOrientation.portraitDown,
  ]);

  runApp(
    // ProviderScope bao toàn bộ app — tất cả Riverpod providers sẽ sống trong này
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

      // ── Themes ───────────────────────────────────────────────────────────
      theme: AppTheme.light,
      darkTheme: AppTheme.dark,
      themeMode: ThemeMode.system, // Phase 6 sẽ đọc từ user preference

      // ── Localization ─────────────────────────────────────────────────────
      locale: const Locale('vi'),
      supportedLocales: AppL10n.supportedLocales,
      localizationsDelegates: const [
        AppL10n.delegate,
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],

      // ── Home — Phase 1: Design System Preview ────────────────────────────
      // Sẽ được thay bằng GoRouter trong Phase 3
      home: const _DesignSystemPreview(),
    );
  }
}

// ── Design System Preview ─────────────────────────────────────────────────────
// Màn hình tạm để verify toàn bộ token & theme hoạt động đúng.
// Sẽ bị xóa khi Phase 3 (Navigation) hoàn thành.

class _DesignSystemPreview extends StatelessWidget {
  const _DesignSystemPreview();

  @override
  Widget build(BuildContext context) {
    final neu = context.neu;
    final cs = context.colorScheme;
    final tt = context.textTheme;

    return Scaffold(
      backgroundColor: neu.surface,
      appBar: AppBar(
        title: const Text('Design System Preview'),
        actions: [
          IconButton(
            icon: Icon(
              context.isLight
                  ? Icons.dark_mode_outlined
                  : Icons.light_mode_outlined,
            ),
            onPressed: () {/* Phase 6 sẽ implement */},
          ),
        ],
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // ── Colors ─────────────────────────────────────────────────
            const _SectionTitle('🎨 Color Tokens'),
            const SizedBox(height: AppSpacing.sm),
            _ColorRow(label: 'Neu Surface', color: neu.surface),
            _ColorRow(label: 'Primary', color: cs.primary),
            _ColorRow(label: 'Secondary', color: cs.secondary),
            _ColorRow(label: 'Error', color: cs.error),
            _ColorRow(label: 'Device Online', color: neu.deviceOnline),
            _ColorRow(label: 'Device Offline', color: neu.deviceOffline),
            _ColorRow(label: 'Device Pending', color: neu.devicePending),

            const SizedBox(height: AppSpacing.lg),

            // ── Shadows ─────────────────────────────────────────────────
            const _SectionTitle('🌑 Neumorphic Shadows'),
            const SizedBox(height: AppSpacing.sm),
            Wrap(
              spacing: AppSpacing.md,
              runSpacing: AppSpacing.md,
              children: [
                _NeuBox(
                    label: 'Raised\nStrong',
                    shadows: neu.raisedStrong.shadows,
                    neu: neu),
                _NeuBox(
                    label: 'Raised\nMedium',
                    shadows: neu.raisedMedium.shadows,
                    neu: neu),
                _NeuBox(
                    label: 'Raised\nSubtle',
                    shadows: neu.raisedSubtle.shadows,
                    neu: neu),
                _NeuBox(label: 'Flat', shadows: neu.flat.shadows, neu: neu),
                _NeuBox(
                    label: 'Pressed',
                    shadows: neu.pressed.shadows,
                    neu: neu),
              ],
            ),

            const SizedBox(height: AppSpacing.lg),

            // ── Typography ──────────────────────────────────────────────
            const _SectionTitle('✏️ Typography'),
            const SizedBox(height: AppSpacing.sm),
            Text('Display Large',
                style: tt.displayLarge?.copyWith(fontSize: 28)),
            Text('Headline Large', style: tt.headlineLarge),
            Text('Headline Medium', style: tt.headlineMedium),
            Text('Title Large', style: tt.titleLarge),
            Text('Title Medium', style: tt.titleMedium),
            Text('Body Large — Văn bản nội dung chính', style: tt.bodyLarge),
            Text('Body Medium — Mô tả phụ, chú thích', style: tt.bodyMedium),
            Text('Body Small — Timestamp, metadata', style: tt.bodySmall),
            Text('LABEL LARGE', style: tt.labelLarge),
            Text('LABEL MEDIUM', style: tt.labelMedium),
            Text('label small', style: tt.labelSmall),

            const SizedBox(height: AppSpacing.lg),

            // ── Spacing ─────────────────────────────────────────────────
            const _SectionTitle('📐 Spacing (4pt grid)'),
            const SizedBox(height: AppSpacing.sm),
            ...[
              ('xs = 4', AppSpacing.xs),
              ('sm = 8', AppSpacing.sm),
              ('md = 16', AppSpacing.md),
              ('lg = 24', AppSpacing.lg),
              ('xl = 32', AppSpacing.xl),
              ('xxl = 48', AppSpacing.xxl),
            ].map((e) => Padding(
                  padding: const EdgeInsets.only(bottom: 4),
                  child: Row(
                    children: [
                      SizedBox(
                        width: 80,
                        child: Text(e.$1, style: tt.labelSmall),
                      ),
                      Container(
                        height: 12,
                        width: e.$2,
                        decoration: BoxDecoration(
                          color: cs.primary,
                          borderRadius: BorderRadius.circular(2),
                        ),
                      ),
                    ],
                  ),
                )),

            const SizedBox(height: AppSpacing.lg),

            // ── Radius ──────────────────────────────────────────────────
            const _SectionTitle('🔲 Border Radius'),
            const SizedBox(height: AppSpacing.sm),
            Wrap(
              spacing: AppSpacing.sm,
              runSpacing: AppSpacing.sm,
              children: [
                _RadiusBox(label: 'xs=4', radius: AppRadius.xs, neu: neu),
                _RadiusBox(label: 'sm=8', radius: AppRadius.sm, neu: neu),
                _RadiusBox(label: 'md=16', radius: AppRadius.md, neu: neu),
                _RadiusBox(label: 'lg=24', radius: AppRadius.lg, neu: neu),
                _RadiusBox(label: 'xl=32', radius: AppRadius.xl, neu: neu),
                _RadiusBox(label: 'full', radius: AppRadius.full, neu: neu),
              ],
            ),

            const SizedBox(height: AppSpacing.lg),

            // ── M3 Components ───────────────────────────────────────────
            const _SectionTitle('🧩 M3 Components'),
            const SizedBox(height: AppSpacing.sm),
            ElevatedButton(
              onPressed: () {},
              child: const Text('ElevatedButton — Nút chính'),
            ),
            const SizedBox(height: AppSpacing.sm),
            OutlinedButton(
              onPressed: () {},
              child: const Text('OutlinedButton — Nút thứ cấp'),
            ),
            const SizedBox(height: AppSpacing.sm),
            TextButton(
              onPressed: () {},
              child: const Text('TextButton — Link Action'),
            ),
            const SizedBox(height: AppSpacing.sm),
            const TextField(
              decoration: InputDecoration(
                labelText: 'Email',
                hintText: 'example@email.com',
                prefixIcon: Icon(Icons.email_outlined),
              ),
            ),
            const SizedBox(height: AppSpacing.sm),
            const Wrap(
              spacing: AppSpacing.sm,
              children: [
                Chip(label: Text('Đèn')),
                Chip(label: Text('Điều hòa')),
                Chip(label: Text('Bảo mật')),
              ],
            ),

            const SizedBox(height: AppSpacing.xl),
          ],
        ),
      ),
    );
  }
}

// ── Helper widgets (chỉ dùng trong Design System Preview) ────────────────────

class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.title);
  final String title;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(title, style: context.titleMedium),
        const SizedBox(height: 4),
        Divider(color: context.colorScheme.outlineVariant),
      ],
    );
  }
}

class _ColorRow extends StatelessWidget {
  const _ColorRow({required this.label, required this.color});
  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) {
    // Hiển thị hex không dùng .value deprecated — dùng component accessors
    final a = (color.a * 255).round();
    final r = (color.r * 255).round();
    final g = (color.g * 255).round();
    final b = (color.b * 255).round();
    final hex =
        '#${a.toRadixString(16).padLeft(2, '0')}${r.toRadixString(16).padLeft(2, '0')}${g.toRadixString(16).padLeft(2, '0')}${b.toRadixString(16).padLeft(2, '0')}'.toUpperCase();

    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(
        children: [
          Container(
            width: 36,
            height: 36,
            decoration: BoxDecoration(
              color: color,
              borderRadius: BorderRadius.circular(AppRadius.sm),
              border: Border.all(
                color: context.colorScheme.outlineVariant,
                width: 0.5,
              ),
            ),
          ),
          const SizedBox(width: AppSpacing.sm),
          Text(label, style: context.bodySmall),
          const SizedBox(width: AppSpacing.sm),
          Text(
            hex,
            style: context.labelSmall?.copyWith(fontFamily: 'monospace'),
          ),
        ],
      ),
    );
  }
}

class _NeuBox extends StatelessWidget {
  const _NeuBox({
    required this.label,
    required this.shadows,
    required this.neu,
  });
  final String label;
  final List<BoxShadow> shadows;
  final NeuColors neu;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 90,
      height: 90,
      decoration: BoxDecoration(
        color: neu.surface,
        borderRadius: BorderRadius.circular(AppRadius.md),
        boxShadow: shadows,
      ),
      child: Center(
        child: Text(
          label,
          textAlign: TextAlign.center,
          style: context.labelSmall,
        ),
      ),
    );
  }
}

class _RadiusBox extends StatelessWidget {
  const _RadiusBox({
    required this.label,
    required this.radius,
    required this.neu,
  });
  final String label;
  final double radius;
  final NeuColors neu;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 72,
      height: 72,
      decoration: BoxDecoration(
        color: neu.surface,
        borderRadius: BorderRadius.circular(radius),
        boxShadow: neu.raisedSubtle.shadows,
      ),
      child: Center(
        child: Text(
          label,
          textAlign: TextAlign.center,
          style: context.labelSmall,
        ),
      ),
    );
  }
}
