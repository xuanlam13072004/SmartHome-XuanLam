// auth_screen.dart now delegates to LoginScreen.
// This file exists for backwards compatibility with router imports.
export 'login_screen.dart' show LoginScreen;

// Re-export LoginScreen as AuthScreen alias so existing router reference works.
import 'login_screen.dart';

typedef AuthScreen = LoginScreen;
