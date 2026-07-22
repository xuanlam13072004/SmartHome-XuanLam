class TokenRefreshMutex {
  static Future<bool>? _inFlight;

  static Future<bool>? get inFlight => _inFlight;

  static Future<bool> run(Future<bool> Function() refresh) {
    final existing = _inFlight;
    if (existing != null) return existing;

    final future = refresh();
    _inFlight = future;
    future.whenComplete(() {
      if (identical(_inFlight, future)) _inFlight = null;
    });
    return future;
  }
}
