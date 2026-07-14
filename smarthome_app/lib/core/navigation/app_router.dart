import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

import '../../features/splash/presentation/splash_screen.dart';
import '../../features/init/presentation/init_screen.dart';
import '../../features/auth/presentation/auth_screen.dart';
import '../../features/dashboard/presentation/dashboard_screen.dart';
import '../../features/rooms/presentation/rooms_screen.dart';
import '../../features/scenes/presentation/scenes_screen.dart';
import '../../features/profile/presentation/profile_screen.dart';
import '../../features/debug/presentation/debug_screen.dart';

import 'app_routes.dart';
import 'app_shell.dart';

part 'app_router.g.dart';

final GlobalKey<NavigatorState> _rootNavigatorKey =
    GlobalKey<NavigatorState>(debugLabel: 'root');

@riverpod
GoRouter router(Ref ref) {
  return GoRouter(
    navigatorKey: _rootNavigatorKey,
    // Ở Phase 3, chúng ta trỏ thẳng vào dashboard để test AppShell
    // Phase sau sẽ đổi về AppRoutes.splash
    initialLocation: AppRoutes.dashboard,
    debugLogDiagnostics: kDebugMode,
    routes: [
      // ── App Lifecycle Routes ───────────────────────────────────────────────
      GoRoute(
        path: AppRoutes.splash,
        parentNavigatorKey: _rootNavigatorKey,
        builder: (context, state) => const SplashScreen(),
      ),
      GoRoute(
        path: AppRoutes.init,
        parentNavigatorKey: _rootNavigatorKey,
        builder: (context, state) => const InitScreen(),
      ),
      GoRoute(
        path: AppRoutes.auth,
        parentNavigatorKey: _rootNavigatorKey,
        builder: (context, state) => const AuthScreen(),
      ),

      // ── Main Shell Routes ────────────────────────────────────────────────
      StatefulShellRoute.indexedStack(
        builder: (context, state, navigationShell) {
          return AppShell(navigationShell: navigationShell);
        },
        branches: [
          // Tab 0: Dashboard
          StatefulShellBranch(
            navigatorKey: GlobalKey<NavigatorState>(debugLabel: 'dashboardNav'),
            routes: [
              GoRoute(
                path: AppRoutes.dashboard,
                pageBuilder: (context, state) => _buildPageWithFadeTransition(
                  context,
                  state,
                  const DashboardScreen(),
                ),
              ),
            ],
          ),
          // Tab 1: Rooms
          StatefulShellBranch(
            navigatorKey: GlobalKey<NavigatorState>(debugLabel: 'roomsNav'),
            routes: [
              GoRoute(
                path: AppRoutes.rooms,
                pageBuilder: (context, state) => _buildPageWithFadeTransition(
                  context,
                  state,
                  const RoomsScreen(),
                ),
              ),
            ],
          ),
          // Tab 2: Scenes
          StatefulShellBranch(
            navigatorKey: GlobalKey<NavigatorState>(debugLabel: 'scenesNav'),
            routes: [
              GoRoute(
                path: AppRoutes.scenes,
                pageBuilder: (context, state) => _buildPageWithFadeTransition(
                  context,
                  state,
                  const ScenesScreen(),
                ),
              ),
            ],
          ),
          // Tab 3: Profile
          StatefulShellBranch(
            navigatorKey: GlobalKey<NavigatorState>(debugLabel: 'profileNav'),
            routes: [
              GoRoute(
                path: AppRoutes.profile,
                pageBuilder: (context, state) => _buildPageWithFadeTransition(
                  context,
                  state,
                  const ProfileScreen(),
                ),
              ),
            ],
          ),
        ],
      ),

      // ── Debug Routes ─────────────────────────────────────────────────────
      if (kDebugMode)
        GoRoute(
          path: AppRoutes.debugWidgets,
          parentNavigatorKey: _rootNavigatorKey,
          // Sử dụng slide transition cho màn hình push thông thường
          pageBuilder: (context, state) => _buildPageWithSlideTransition(
            context,
            state,
            const DebugScreen(),
          ),
        ),
    ],
  );
}

// ── Transition Builders ────────────────────────────────────────────────────

/// Transition khi chuyển Tab (Fade + Scale nhẹ)
CustomTransitionPage<void> _buildPageWithFadeTransition(
  BuildContext context,
  GoRouterState state,
  Widget child,
) {
  return CustomTransitionPage<void>(
    key: state.pageKey,
    child: child,
    transitionsBuilder: (context, animation, secondaryAnimation, child) {
      // Scale nhẹ từ 0.95 lên 1.0
      final scaleAnimation = Tween<double>(begin: 0.95, end: 1.0).animate(
        CurvedAnimation(parent: animation, curve: Curves.easeOut),
      );
      return FadeTransition(
        opacity: animation,
        child: ScaleTransition(
          scale: scaleAnimation,
          child: child,
        ),
      );
    },
  );
}

/// Transition khi Push/Pop màn hình thường (Slide từ trái/phải)
CustomTransitionPage<void> _buildPageWithSlideTransition(
  BuildContext context,
  GoRouterState state,
  Widget child,
) {
  return CustomTransitionPage<void>(
    key: state.pageKey,
    child: child,
    transitionsBuilder: (context, animation, secondaryAnimation, child) {
      const begin = Offset(1.0, 0.0);
      const end = Offset.zero;
      const curve = Curves.easeOutQuart;

      final tween = Tween(begin: begin, end: end).chain(CurveTween(curve: curve));

      return SlideTransition(
        position: animation.drive(tween),
        child: child,
      );
    },
  );
}
