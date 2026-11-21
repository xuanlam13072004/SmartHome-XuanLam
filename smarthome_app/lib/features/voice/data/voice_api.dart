import 'dart:typed_data';

import 'package:dio/dio.dart';

import 'voice_models.dart';

/// Voice profile endpoints (`/voice/…`), always for the signed-in account.
/// Recordings are 16 kHz mono WAV files sent as multipart/form-data.
class VoiceApi {
  VoiceApi(this._dio);

  final Dio _dio;

  /// Enrollment trains the profile's anti-spoof model on the server.
  static const _slow = Duration(minutes: 2);

  static MultipartFile _wav(Uint8List bytes, String name) =>
      MultipartFile.fromBytes(bytes, filename: '$name.wav', contentType: DioMediaType('audio', 'wav'));

  static FormData _form(Map<String, List<Uint8List>> files, [Map<String, String> fields = const {}]) {
    final form = FormData();
    form.fields.addAll(fields.entries);
    for (final entry in files.entries) {
      for (final (index, bytes) in entry.value.indexed) {
        form.files.add(MapEntry(entry.key, _wav(bytes, '${entry.key}-$index')));
      }
    }
    return form;
  }

  Future<VoiceState> fetch() async {
    final response = await _dio.get<Map<String, dynamic>>('/voice/profile');
    return VoiceState.fromJson(response.data!);
  }

  Future<VoiceProfile> enroll({required Uint8List ambient, required List<Uint8List> samples}) async {
    final response = await _dio.post<Map<String, dynamic>>(
      '/voice/profile',
      data: _form({'ambient': [ambient], 'samples': samples}, {'consent': 'true'}),
      options: Options(receiveTimeout: _slow, sendTimeout: _slow),
    );
    return VoiceProfile.fromJson(Map<String, dynamic>.from(response.data!['profile'] as Map));
  }

  Future<VoiceVerification> verify(Uint8List audio) async {
    final response = await _dio.post<Map<String, dynamic>>(
      '/voice/verify',
      data: _form({'audio': [audio]}),
      options: Options(receiveTimeout: const Duration(seconds: 30)),
    );
    return VoiceVerification.fromJson(response.data!);
  }

  Future<VoiceProfile> calibrate(List<Uint8List> samples) async {
    final response = await _dio.post<Map<String, dynamic>>(
      '/voice/calibrate',
      data: _form({'samples': samples}),
      options: Options(receiveTimeout: const Duration(seconds: 60)),
    );
    return VoiceProfile.fromJson(Map<String, dynamic>.from(response.data!['summary'] as Map));
  }

  Future<VoiceProfile> addSample(Uint8List audio) async {
    final response = await _dio.post<Map<String, dynamic>>(
      '/voice/samples',
      data: _form({'audio': [audio]}),
      options: Options(receiveTimeout: const Duration(seconds: 60)),
    );
    return VoiceProfile.fromJson(Map<String, dynamic>.from(response.data!['profile'] as Map));
  }

  /// Replays of my voice through another speaker, for the anti-spoof model.
  Future<VoiceProfile> addReplays(List<Uint8List> samples) async {
    final response = await _dio.post<Map<String, dynamic>>(
      '/voice/antispoof',
      data: _form({'samples': samples}),
      options: Options(receiveTimeout: const Duration(seconds: 60)),
    );
    return VoiceProfile.fromJson(Map<String, dynamic>.from(response.data!['profile'] as Map));
  }

  Future<void> delete({required String password}) async {
    await _dio.delete<void>('/voice/profile', data: {'password': password});
  }

  /// Which recording a server error is about: an index into the uploaded
  /// samples, `ambient`, or null.
  static Object? failedSample(Object? error) {
    if (error is! DioException) return null;
    final data = error.response?.data;
    if (data is! Map || data['error'] is! Map) return null;
    final details = (data['error'] as Map)['details'];
    return details is Map ? details['sample'] : null;
  }
}
