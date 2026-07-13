import 'package:flutter/material.dart';
import '../../core.dart';
import '../primitives/neu_container.dart';

/// Loading indicator phong cách Neumorphism
class LoadingIndicator extends StatefulWidget {
  const LoadingIndicator({
    super.key,
    this.size = 48.0,
  });

  final double size;

  @override
  State<LoadingIndicator> createState() => _LoadingIndicatorState();
}

class _LoadingIndicatorState extends State<LoadingIndicator> with SingleTickerProviderStateMixin {
  late final AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 1),
    )..repeat();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return NeuContainer(
      width: widget.size,
      height: widget.size,
      shape: BoxShape.circle,
      depth: NeuDepth.pressed,
      child: Center(
        child: RotationTransition(
          turns: _controller,
          child: SizedBox(
            width: widget.size * 0.5,
            height: widget.size * 0.5,
            child: CircularProgressIndicator(
              strokeWidth: 3.0,
              valueColor: AlwaysStoppedAnimation<Color>(context.colorScheme.primary),
              backgroundColor: Colors.transparent,
            ),
          ),
        ),
      ),
    );
  }
}
