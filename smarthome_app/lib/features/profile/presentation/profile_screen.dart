import 'package:flutter/material.dart';
import '../../../core/core.dart';
import '../../../core/widgets/widgets.dart';

class ProfileScreen extends StatelessWidget {
  const ProfileScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return PageScaffold(
      appBar: AppBar(
        title: const Text('Profile'),
      ),
      child: Center(
        child: Text('Profile Content', style: context.textTheme.headlineMedium),
      ),
    );
  }
}
