import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';
import '../config/app_config.dart';
import '../storage/token_storage_provider.dart';
import 'auth_interceptor.dart';
import 'package:flutter/foundation.dart';

part 'dio_provider.g.dart';

@riverpod
Dio dio(Ref ref) {
  final dio = Dio(
    BaseOptions(
      baseUrl: AppConfig.baseUrl,
      connectTimeout: const Duration(seconds: 10),
      receiveTimeout: const Duration(seconds: 10),
    ),
  );

  if (kDebugMode) {
    dio.interceptors.add(
      LogInterceptor(
        request: true,
        // Headers and bodies contain JWTs, passwords, refresh tokens and
        // device secrets. Never print them, even in debug builds.
        requestHeader: false,
        requestBody: false,
        responseHeader: false,
        responseBody: false,
        error: true,
      ),
    );
  }

  dio.interceptors.add(
    AuthInterceptor(
      tokenStorage: ref.watch(tokenStorageProvider),
      dio: dio,
    ),
  );

  return dio;
}
