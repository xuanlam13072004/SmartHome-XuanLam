import 'dart:async';

import '../data/camera_api.dart';

/// Keeps one media session alive while a player shows it: renews before the
/// TTL ends and closes it when the viewer leaves (camera contract 7.1, step 6).
class CameraSessionHolder {
  CameraSessionHolder(this._api);

  final CameraApi _api;
  CameraMediaSession? _session;
  Timer? _renewTimer;
  int _generation = 0;

  CameraMediaSession? get session => _session;

  Future<CameraMediaSession> open(
    String mac, {
    required String instanceId,
    required String resourceId,
    Map<String, dynamic> input = const {},
  }) async {
    await close();
    final generation = ++_generation;
    final session = await _api.openSession(
      mac,
      instanceId: instanceId,
      resourceId: resourceId,
      input: input,
    );
    if (generation != _generation) {
      unawaited(_closeQuietly(session));
      throw const CameraApiException('RESOURCE_SESSION_INACTIVE');
    }
    _session = session;
    _scheduleRenew(session.expiresAt);
    return session;
  }

  void _scheduleRenew(DateTime expiresAt) {
    _renewTimer?.cancel();
    final wait = expiresAt.difference(DateTime.now()) - const Duration(seconds: 60);
    _renewTimer = Timer(wait.isNegative ? const Duration(seconds: 5) : wait, () async {
      final session = _session;
      if (session == null) return;
      try {
        final next = await _api.renewSession(session.mac, session.sessionId);
        if (_session == session) _scheduleRenew(next);
      } catch (_) {
        // The relay ends the stream once the session expires; the player
        // reports it and the user can reopen.
      }
    });
  }

  Future<void> close() async {
    _generation++;
    _renewTimer?.cancel();
    _renewTimer = null;
    final session = _session;
    _session = null;
    if (session != null) await _closeQuietly(session);
  }

  Future<void> _closeQuietly(CameraMediaSession session) async {
    try {
      await _api.closeSession(session.mac, session.sessionId);
    } catch (_) {
      // Already expired or revoked.
    }
  }
}
