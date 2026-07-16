import 'package:dio/dio.dart';

abstract class IAuthRemoteDataSource {
  Future<Map<String, dynamic>> login(String email, String password);
  Future<Map<String, dynamic>> register(String email, String password);
  Future<Map<String, dynamic>> refresh(String refreshToken);
  Future<void> logout(String refreshToken);
}

class AuthRemoteDataSourceImpl implements IAuthRemoteDataSource {
  final Dio _dio;

  AuthRemoteDataSourceImpl(this._dio);

  @override
  Future<Map<String, dynamic>> login(String email, String password) async {
    final response = await _dio.post<Map<String, dynamic>>(
      '/auth/login',
      data: {
        'email': email,
        'password': password,
      },
      options: Options(extra: {'skipAuth': true}),
    );
    return response.data!;
  }

  @override
  Future<Map<String, dynamic>> register(String email, String password) async {
    final response = await _dio.post<Map<String, dynamic>>(
      '/auth/register',
      data: {
        'email': email,
        'password': password,
      },
      options: Options(extra: {'skipAuth': true}),
    );
    return response.data!;
  }

  @override
  Future<Map<String, dynamic>> refresh(String refreshToken) async {
    final response = await _dio.post<Map<String, dynamic>>(
      '/auth/refresh',
      data: {
        'refreshToken': refreshToken,
      },
      options: Options(extra: {'skipAuth': true}),
    );
    return response.data!;
  }

  @override
  Future<void> logout(String refreshToken) async {
    await _dio.post<void>(
      '/auth/logout',
      data: {
        'refreshToken': refreshToken,
      },
      options: Options(extra: {'skipAuth': true}),
    );
  }
}
