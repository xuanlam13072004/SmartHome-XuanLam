abstract class IAuthRepository {
  Future<String?> getToken();
}

class TestAuthRepositoryImpl implements IAuthRepository {
  @override
  Future<String?> getToken() async {
    // Mock JWT Token generated from backend scripts for testing WS
    // Payload: { userId: 'test_user_123', email: 'test@example.com' }
    return 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJ0ZXN0X3VzZXJfMTIzIiwiZW1haWwiOiJ0ZXN0QGV4YW1wbGUuY29tIiwiaWF0IjoxNzg0MTczODg2LCJleHAiOjE4MTU3MzE0ODZ9.6Cm-lbal3ITOxQ5Wz2cyByqUZBpKBDE_tuzAr4uBDho';
  }
}
