import 'package:flutter/material.dart';
import '../../../core/core.dart';
import '../../../core/widgets/widgets.dart';

class ScenesScreen extends StatelessWidget {
  const ScenesScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return PageScaffold(
      appBar: AppBar(
        title: const Text('Scenes'),
      ),
      child: Center(
        child: Text('Scenes Content', style: context.textTheme.headlineMedium),
      ),
    );
  }
}
