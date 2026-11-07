import 'package:flutter/material.dart';

import 'hls_video_controller.dart';

/// Non-web builds: the camera player currently targets the web app
/// (hls.js). Mobile/desktop players can replace this file later.
class HlsVideoView extends StatefulWidget {
  const HlsVideoView({
    super.key,
    required this.url,
    required this.controller,
    this.live = false,
  });

  final String url;
  final HlsVideoController controller;
  final bool live;

  @override
  State<HlsVideoView> createState() => _HlsVideoViewState();
}

class _HlsVideoViewState extends State<HlsVideoView> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      widget.controller.report(
        HlsPlayerPhase.error,
        'Trình phát camera hiện chỉ hỗ trợ bản web của ứng dụng.',
      );
    });
  }

  @override
  Widget build(BuildContext context) => const ColoredBox(color: Colors.black);
}
