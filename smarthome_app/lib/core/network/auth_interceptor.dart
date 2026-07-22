import 'package:dio/dio.dart';
import '../storage/token_storage.dart';
import 'token_refresh_mutex.dart';

class AuthInterceptor extends Interceptor {
  final ITokenStorage tokenStorage;
  final Dio dio;

  AuthInterceptor({
    required this.tokenStorage,
    required this.dio,
  });

  @override
  void onRequest(
      RequestOptions options, RequestInterceptorHandler handler) async {
    // Check if the request explicitly skips auth (e.g. login, register, refresh)
    if (options.extra['skipAuth'] == true) {
      return handler.next(options);
    }

    // Always wait if currently refreshing
    final refreshInFlight = TokenRefreshMutex.inFlight;
    if (refreshInFlight != null) {
      final success = await refreshInFlight;
      if (success != true) {
        return handler.reject(
          DioException(requestOptions: options, error: 'Token refresh failed'),
        );
      }
    }

    final token = await tokenStorage.getAccessToken();
    if (token != null) {
      options.headers['Authorization'] = 'Bearer $token';
    }

    handler.next(options);
  }

  @override
  void onError(DioException err, ErrorInterceptorHandler handler) async {
    final bool skipAuth = err.requestOptions.extra['skipAuth'] == true;

    final alreadyRetried = err.requestOptions.extra['authRetried'] == true;
    if (err.response?.statusCode == 401 && !skipAuth && !alreadyRetried) {
      final success = await TokenRefreshMutex.run(() async {
        try {
          final refreshToken = await tokenStorage.getRefreshToken();
          final sessionId = await tokenStorage.getSessionId();
          if (refreshToken == null || sessionId == null) {
            throw Exception('No refresh token or session id');
          }

          final res = await dio.post<Map<String, dynamic>>(
            '/auth/refresh',
            data: {'session_id': sessionId, 'refresh_token': refreshToken},
            options: Options(extra: {'skipAuth': true}),
          );

          final data = res.data!;
          final newAccessToken = data['access_token'] as String?;
          final newRefreshToken = data['refresh_token'] as String?;
          final newSessionId = data['session_id'] as String?;

          if (newAccessToken != null &&
              newRefreshToken != null &&
              newSessionId != null) {
            await tokenStorage.saveTokens(
              accessToken: newAccessToken,
              refreshToken: newRefreshToken,
              sessionId: newSessionId,
            );

            return true;
          } else {
            throw Exception('Invalid token response');
          }
        } catch (e) {
          await tokenStorage.clearTokens();
          return false;
        }
      });

      if (success) return _retryRequest(err.requestOptions, handler);
      return handler.next(err);
    }

    handler.next(err);
  }

  Future<void> _retryRequest(
      RequestOptions requestOptions, ErrorInterceptorHandler handler) async {
    final token = await tokenStorage.getAccessToken();
    if (token == null) {
      return handler.next(
        DioException(
            requestOptions: requestOptions,
            error: 'Access token unavailable after refresh'),
      );
    }
    requestOptions.headers['Authorization'] = 'Bearer $token';
    requestOptions.extra['authRetried'] = true;

    try {
      final response = await dio.fetch<dynamic>(requestOptions);
      handler.resolve(response);
    } on DioException catch (e) {
      handler.next(e);
    }
  }
}
