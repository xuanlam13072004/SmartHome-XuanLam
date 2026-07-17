import 'dart:async';
import 'package:dio/dio.dart';
import '../storage/token_storage.dart';

class AuthInterceptor extends Interceptor {
  final ITokenStorage tokenStorage;
  final Dio dio;
  
  // Refresh Token Mutex implementation
  bool _isRefreshing = false;
  Completer<bool>? _refreshTokenCompleter;

  AuthInterceptor({
    required this.tokenStorage,
    required this.dio,
  });

  @override
  void onRequest(RequestOptions options, RequestInterceptorHandler handler) async {
    // Check if the request explicitly skips auth (e.g. login, register, refresh)
    if (options.extra['skipAuth'] == true) {
      return handler.next(options);
    }
    
    // Always wait if currently refreshing
    if (_isRefreshing) {
      final success = await _refreshTokenCompleter?.future;
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
    
    if (err.response?.statusCode == 401 && !skipAuth) {
      if (_isRefreshing) {
        final success = await _refreshTokenCompleter?.future;
        if (success == true) {
          return _retryRequest(err.requestOptions, handler);
        } else {
          return handler.next(err);
        }
      }

      _isRefreshing = true;
      _refreshTokenCompleter = Completer<bool>();

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
        
        if (newAccessToken != null && newRefreshToken != null && newSessionId != null) {
          await tokenStorage.saveTokens(
            accessToken: newAccessToken,
            refreshToken: newRefreshToken,
            sessionId: newSessionId,
          );
          
          _refreshTokenCompleter?.complete(true);
          _isRefreshing = false;
          
          return _retryRequest(err.requestOptions, handler);
        } else {
          throw Exception('Invalid token response');
        }
      } catch (e) {
        await tokenStorage.clearTokens();
        _refreshTokenCompleter?.complete(false);
        _isRefreshing = false;
        return handler.next(err);
      }
    }
    
    handler.next(err);
  }

  Future<void> _retryRequest(RequestOptions requestOptions, ErrorInterceptorHandler handler) async {
    final token = await tokenStorage.getAccessToken();
    requestOptions.headers['Authorization'] = 'Bearer $token';
    
    try {
      final response = await dio.request<dynamic>(
        requestOptions.path,
        data: requestOptions.data,
        queryParameters: requestOptions.queryParameters,
        options: Options(
          method: requestOptions.method,
          headers: requestOptions.headers,
          extra: requestOptions.extra,
        ),
      );
      handler.resolve(response);
    } on DioException catch (e) {
      handler.next(e);
    }
  }
}
