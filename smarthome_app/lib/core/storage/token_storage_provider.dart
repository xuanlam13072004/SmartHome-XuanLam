import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';
import 'token_storage.dart';

part 'token_storage_provider.g.dart';

@Riverpod(keepAlive: true)
ITokenStorage tokenStorage(Ref ref) {
  return const SecureTokenStorageImpl();
}
