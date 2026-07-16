import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';
import '../repositories/auth_repository.dart';

part 'auth_provider.g.dart';

@riverpod
IAuthRepository authRepository(Ref ref) {
  return TestAuthRepositoryImpl();
}
