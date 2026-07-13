import 'package:flutter/material.dart';
import '../../core.dart';

/// Page Scaffold chuẩn của ứng dụng.
/// Xử lý SafeArea, nền NeuSurface và tùy chọn scroll.
class PageScaffold extends StatelessWidget {
  const PageScaffold({
    super.key,
    required this.child,
    this.appBar,
    this.scrollable = true,
    this.padding = EdgeInsets.zero,
    this.floatingActionButton,
  });

  final Widget child;
  final PreferredSizeWidget? appBar;
  final bool scrollable;
  final EdgeInsetsGeometry padding;
  final Widget? floatingActionButton;

  @override
  Widget build(BuildContext context) {
    Widget body = Padding(
      padding: padding,
      child: child,
    );

    if (scrollable) {
      body = SingleChildScrollView(
        child: body,
      );
    }

    return Scaffold(
      backgroundColor: context.neu.surface,
      appBar: appBar,
      body: SafeArea(
        child: body,
      ),
      floatingActionButton: floatingActionButton,
    );
  }
}
