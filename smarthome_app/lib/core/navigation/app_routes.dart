abstract final class AppRoutes {
  // App Lifecycle
  static const String splash = '/';
  static const String init = '/init';
  static const String auth = '/auth';
  static const String register = '/register';

  // Main Shell Tabs
  static const String dashboard = '/dashboard';
  static const String rooms = '/rooms';
  static const String scenes = '/scenes';
  static const String profile = '/profile';

  // Feature Routes
  static const String deviceDetail = '/device/:id';

  // Debug Routes
  static const String debugWidgets = '/debug/widgets';
  static const String debugTheme = '/debug/theme';
  static const String debugTypography = '/debug/typography';
}
