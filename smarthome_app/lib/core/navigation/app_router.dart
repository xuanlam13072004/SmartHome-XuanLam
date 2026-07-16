import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

import '../../features/splash/presentation/splash_screen.dart';
import '../../features/init/presentation/init_screen.dart';
import '../../features/auth/presentation/auth_screen.dart';
import '../../features/auth/presentation/register_screen.dart';
import '../../features/auth/providers/auth_provider.dart';
import '../../features/dashboard/presentation/dashboard_screen.dart';
import '../../features/dashboard/presentation/device_detail_screen.dart';
import '../../features/rooms/presentation/rooms_screen.dart';
import '../../features/scenes/presentation/scenes_screen.dart';
import '../../features/profile/presentation/profile_screen.dart';
import '../../features/debug/presentation/debug_screen.dart';

import 'app_routes.dart';
import 'app_shell.dart';

part 'app_router.g.dart';

final GlobalKey<NavigatorState> _rootNavigatorKey =
    GlobalKey<NavigatorState>(debugLabel: 'root');

// Navigator keys for shell branches — defined once at top-level to avoid
// recreation on every GoRouter rebuild.
final GlobalKey<NavigatorState> _dashboardNavKey =
    GlobalKey<NavigatorState>(debugLabel: 'dashboardNav');
final GlobalKey<NavigatorState> _roomsNavKey =
    GlobalKey<NavigatorState>(debugLabel: 'roomsNav');
final GlobalKey<NavigatorState> _scenesNavKey =
    GlobalKey<NavigatorState>(debugLabel: 'scenesNav');
final GlobalKey<NavigatorState> _profileNavKey =
    GlobalKey<NavigatorState>(debugLabel: 'profileNav');

@riverpod
GoRouter router(Ref ref) {
  // Listen to auth state changes and refresh the router.
  // Using `ref.listen` instead of `ref.watch` avoids recreating the GoRouter
  // object every time the auth state changes. Instead we call `.refresh()`
  // which re-evaluates the redirect without rebuilding the entire route tree.
  final authNotifier = ValueNotifier<AuthState>(AuthState.unknown);
  ref.listen<AuthState>(authControllerProvider, (_, next) {
    authNotifier.value = next;
  });
  // Also initialise with current value.
  authNotifier.value = ref.read(authControllerProvider);

  final router = GoRouter(
    navigatorKey: _rootNavigatorKey,
    initialLocation: AppRoutes.splash,
    debugLogDiagnostics: kDebugMode,
    refreshListenable: authNotifier,
    redirect: (context, state) {
      final authState = authNotifier.value;
      final isSplash = state.uri.path == AppRoutes.splash;
      final isAuth = state.uri.path == AppRoutes.auth;
      final isRegister = state.uri.path == AppRoutes.register;

      if (authState == AuthState.unknown || authState == AuthState.checking) {
        if (!isSplash) return AppRoutes.splash;
        return null;
      }

      if (authState == AuthState.unauthenticated || authState == AuthState.expired) {
        if (!isAuth && !isRegister) {
          return AppRoutes.auth;
        }
        return null;
      }

      if (authState == AuthState.authenticated) {
        if (isSplash || isAuth || isRegister) {
          return AppRoutes.dashboard;
        }
      }

      return null;
    },
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
      GoRoute(
        path: AppRoutes.register,
        parentNavigatorKey: _rootNavigatorKey,
        builder: (context, state) => const RegisterScreen(),
      ),

      // ── Main Shell Routes ────────────────────────────────────────────────
      StatefulShellRoute.indexedStack(
        builder: (context, state, navigationShell) {
          return AppShell(navigationShell: navigationShell);
        },
        branches: [
          // Tab 0: Dashboard
          StatefulShellBranch(
            navigatorKey: _dashboardNavKey,
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
            navigatorKey: _roomsNavKey,
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
            navigatorKey: _scenesNavKey,
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
            navigatorKey: _profileNavKey,
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

      // ── Feature Routes ───────────────────────────────────────────────────
      GoRoute(
        path: AppRoutes.deviceDetail,
        parentNavigatorKey: _rootNavigatorKey,
        pageBuilder: (context, state) {
          final id = state.pathParameters['id']!;
          return _buildPageWithSlideTransition(
            context,
            state,
            DeviceDetailScreen(deviceId: id),
          );
        },
      ),

      // ── Debug Routes ─────────────────────────────────────────────────────
      if (kDebugMode)
        GoRoute(
          path: AppRoutes.debugWidgets,
          parentNavigatorKey: _rootNavigatorKey,
          pageBuilder: (context, state) => _buildPageWithSlideTransition(
            context,
            state,
            const DebugScreen(),
          ),
        ),
    ],
  );

  ref.onDispose(() {
    authNotifier.dispose();
    router.dispose();
  });

  return router;
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
