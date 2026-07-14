import 'package:flutter/material.dart';
import '../../../core/core.dart';
import '../../../core/widgets/widgets.dart';

class RoomsScreen extends StatelessWidget {
  const RoomsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return PageScaffold(
      appBar: AppBar(
        title: const Text('Rooms'),
      ),
      child: Center(
        child: Text('Rooms Content', style: context.textTheme.headlineMedium),
      ),
    );
  }
}
