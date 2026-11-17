import 'dart:async';

/// Announces that the stored login session is gone for good: signed out from
/// another device, password changed elsewhere, or account deleted. The auth
/// controller listens and returns the app to the sign-in screen.
abstract final class SessionEvents {
  static final StreamController<void> _expired = StreamController<void>.broadcast();

  static Stream<void> get expired => _expired.stream;

  static void notifyExpired() => _expired.add(null);
}
