import 'package:flutter/material.dart';
import '../../../core/core.dart';
import '../../../core/widgets/widgets.dart';

class DashboardScreen extends StatelessWidget {
  const DashboardScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return PageScaffold(
      appBar: AppBar(
        title: const Text('Dashboard'),
      ),
      child: Center(
        child: Text('Dashboard Content', style: context.textTheme.headlineMedium),
      ),
    );
  }
}
