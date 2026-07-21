import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import '../constants/storage_keys.dart';

abstract class ITokenStorage {
  Future<void> saveTokens({required String accessToken, required String refreshToken, required String sessionId});
  Future<String?> getAccessToken();
  Future<String?> getRefreshToken();
  Future<String?> getSessionId();
  Future<void> clearTokens();
  Future<void> saveUserId(String userId);
  Future<String?> getUserId();
  Future<void> saveUserProfile({required String fullName, required String email, required String username});
  Future<String?> getUserFullName();
  Future<String?> getUserEmail();
  Future<String?> getUserUsername();
}

class SecureTokenStorageImpl implements ITokenStorage {
  final FlutterSecureStorage _storage;

  const SecureTokenStorageImpl({
    FlutterSecureStorage storage = const FlutterSecureStorage(),
  }) : _storage = storage;

  @override
  Future<void> saveTokens({required String accessToken, required String refreshToken, required String sessionId}) async {
    await _storage.write(key: StorageKeys.accessToken, value: accessToken);
    await _storage.write(key: StorageKeys.refreshToken, value: refreshToken);
    await _storage.write(key: StorageKeys.sessionId, value: sessionId);
  }

  @override
  Future<String?> getAccessToken() async {
    return await _storage.read(key: StorageKeys.accessToken);
  }

  @override
  Future<String?> getRefreshToken() async {
    return await _storage.read(key: StorageKeys.refreshToken);
  }

  @override
  Future<String?> getSessionId() async {
    return await _storage.read(key: StorageKeys.sessionId);
  }

  @override
  Future<void> clearTokens() async {
    await _storage.delete(key: StorageKeys.accessToken);
    await _storage.delete(key: StorageKeys.refreshToken);
    await _storage.delete(key: StorageKeys.sessionId);
    await _storage.delete(key: StorageKeys.userId);
    await _storage.delete(key: StorageKeys.userFullName);
    await _storage.delete(key: StorageKeys.userEmail);
    await _storage.delete(key: StorageKeys.userUsername);
  }

  @override
  Future<void> saveUserId(String userId) async {
    await _storage.write(key: StorageKeys.userId, value: userId);
  }

  @override
  Future<String?> getUserId() async {
    return await _storage.read(key: StorageKeys.userId);
  }

  @override
  Future<void> saveUserProfile({required String fullName, required String email, required String username}) async {
    await _storage.write(key: StorageKeys.userFullName, value: fullName);
    await _storage.write(key: StorageKeys.userEmail, value: email);
    await _storage.write(key: StorageKeys.userUsername, value: username);
  }

  @override
  Future<String?> getUserFullName() async {
    return await _storage.read(key: StorageKeys.userFullName);
  }

  @override
  Future<String?> getUserEmail() async {
    return await _storage.read(key: StorageKeys.userEmail);
  }

  @override
  Future<String?> getUserUsername() async {
    return await _storage.read(key: StorageKeys.userUsername);
  }
}
