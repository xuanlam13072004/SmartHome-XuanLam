abstract final class AppRoutes {
  // App Lifecycle
  static const String splash = '/';
  static const String init = '/init';
  static const String auth = '/auth';
  static const String register = '/register';

  // Main Shell Tabs
  static const String dashboard = '/dashboard';
  static const String rooms = '/rooms';
  static const String roomDetail = '/rooms/:roomId';

  static String roomDetailOf(String roomId) => '/rooms/$roomId';
  static const String scenes = '/scenes';
  static const String sceneNew = '/scenes/new';
  static const String sceneHistory = '/scenes/history';

  static String sceneEditOf(String sceneId) => '/scenes/$sceneId/edit';
  static const String automationNew = '/scenes/automations/new';

  static String automationEditOf(String automationId) => '/scenes/automations/$automationId/edit';
  static const String profile = '/profile';

  // Account center (nested under the Cá nhân tab, bottom bar stays visible)
  static const String profileHelp = '/profile/help';
  static const String profileSessions = '/profile/sessions';
  static const String profileDeleteAccount = '/profile/delete-account';
  static const String profileSharing = '/profile/sharing';
  static const String profileNotifications = '/profile/notifications';
  static const String profileNotificationSettings = '/profile/notifications/settings';
  static const String profileActivity = '/profile/activity';

  // Feature Routes
  static const String deviceDetail = '/device/:mac';
  static const String deviceMembers = '/device/:mac/members';

  static String deviceMembersOf(String mac) => '/device/$mac/members';

  // Debug Routes
  static const String debugWidgets = '/debug/widgets';
  static const String debugTheme = '/debug/theme';
  static const String debugTypography = '/debug/typography';
}
