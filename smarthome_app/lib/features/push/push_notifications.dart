import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/network/dio_provider.dart';
import '../auth/providers/auth_provider.dart';
import 'data/push_api.dart';

/// Where push notifications stand on this phone.
enum PushStatus {
  /// Web and desktop builds: no push.
  unsupported,

  /// Signed out, or not started yet.
  idle,

  /// This build has no Firebase config (android/app/google-services.json,
  /// ios/Runner/GoogleService-Info.plist), see docs/architecture/push.md.
  notConfigured,

  /// The user turned notifications off for the app.
  denied,

  /// Registered; the server says whether it can send ([serverReady]).
  enabled,
}

/// Screens a notification may open (the server sends the route).
const _openableRoutes = [
  '/device/',
  '/profile/notifications',
  '/profile/voice',
  '/profile/plans',
  '/profile/sharing',
  '/assistant',
];

/// Push notifications through Firebase Cloud Messaging, for when the app is
/// closed: alerts, automation and security notices, payments, sharing and
/// plan reminders (docs/architecture/push.md). While the app is open the
/// realtime connection already shows them, so incoming pushes are ignored
/// then. The phone is registered for the signed-in session only; signing out
/// unregisters it and deletes the token, so the next account starts clean.
class PushNotifications extends ChangeNotifier {
  PushNotifications(this._ref) : _status = supported ? PushStatus.idle : PushStatus.unsupported;

  final Ref _ref;
  final List<StreamSubscription<Object?>> _subscriptions = [];
  final StreamController<String> _taps = StreamController<String>.broadcast();
  PushStatus _status;
  bool _serverReady = false;
  bool _firebaseReady = false;
  bool _running = false;
  String? _token;

  static bool get supported =>
      !kIsWeb && (defaultTargetPlatform == TargetPlatform.android || defaultTargetPlatform == TargetPlatform.iOS);

  PushStatus get status => _status;

  /// The server has a Firebase service account (otherwise nothing is sent).
  bool get serverReady => _serverReady;

  /// Routes of tapped notifications, for the app shell to open.
  Stream<String> get taps => _taps.stream;

  PushApi get _api => PushApi(_ref.read(dioProvider));

  void _set(PushStatus status) {
    if (_status == status) return;
    _status = status;
    notifyListeners();
  }

  /// After sign-in: asks permission (once), registers this phone and follows
  /// token changes and taps. Calling it again retries after a refusal.
  Future<void> start() async {
    if (_running || !supported) return;
    _running = true;
    if (!await _initFirebase()) {
      _running = false;
      _set(PushStatus.notConfigured);
      return;
    }
    final messaging = FirebaseMessaging.instance;
    try {
      final settings = await messaging.requestPermission();
      if (!_running) return;
      if (settings.authorizationStatus == AuthorizationStatus.denied) {
        _running = false;
        _set(PushStatus.denied);
        return;
      }
      _subscriptions
        ..add(FirebaseMessaging.onMessageOpenedApp.listen((message) => _open(message.data)))
        ..add(messaging.onTokenRefresh.listen((token) => unawaited(_register(token))));
      final initial = await messaging.getInitialMessage();
      if (initial != null) _open(initial.data);
      final token = await messaging.getToken();
      if (token != null) await _register(token);
      if (_running) _set(PushStatus.enabled);
    } catch (error) {
      debugPrint('Push notifications unavailable: $error');
      _running = false;
      _set(PushStatus.notConfigured);
    }
  }

  Future<bool> _initFirebase() async {
    if (_firebaseReady) return true;
    try {
      if (Firebase.apps.isEmpty) await Firebase.initializeApp();
      _firebaseReady = true;
    } catch (error) {
      debugPrint('Firebase is not configured for this build: $error');
    }
    return _firebaseReady;
  }

  Future<void> _register(String token) async {
    _token = token;
    try {
      _serverReady = await _api.register(token, defaultTargetPlatform == TargetPlatform.iOS ? 'ios' : 'android');
      notifyListeners();
    } catch (error) {
      debugPrint('Could not register this phone for push notifications: $error');
    }
  }

  void _open(Map<String, dynamic> data) {
    final route = data['route'];
    if (route is String && _openableRoutes.any(route.startsWith) && !_taps.isClosed) _taps.add(route);
  }

  /// Signing out on this phone. [signedIn]: the session still works, so the
  /// server is told right away; otherwise deleting the token is enough (the
  /// server also skips phones of ended sessions).
  Future<void> stop({required bool signedIn}) async {
    if (!_running && _token == null) return;
    _running = false;
    for (final subscription in _subscriptions) {
      await subscription.cancel();
    }
    _subscriptions.clear();
    final token = _token;
    _token = null;
    _serverReady = false;
    _set(PushStatus.idle);
    if (!_firebaseReady) return;
    if (signedIn && token != null) {
      try {
        await _api.remove(token).timeout(const Duration(seconds: 5));
      } catch (_) {
        // The token is deleted below anyway.
      }
    }
    try {
      await FirebaseMessaging.instance.deleteToken();
    } catch (_) {
      // Offline: the server stops sending once the session has ended.
    }
  }

  Future<int> sendTest() => _api.test();

  @override
  void dispose() {
    for (final subscription in _subscriptions) {
      unawaited(subscription.cancel());
    }
    unawaited(_taps.close());
    super.dispose();
  }
}

final pushNotificationsProvider = ChangeNotifierProvider<PushNotifications>((ref) {
  final push = PushNotifications(ref);
  ref.listen<AuthState>(authControllerProvider, (previous, next) {
    if (next == AuthState.unauthenticated || next == AuthState.expired) unawaited(push.stop(signedIn: false));
  });
  return push;
});
