import 'dart:typed_data';

import 'package:dio/dio.dart';

import 'assistant_models.dart';

/// Assistant endpoints (`/assistant/…`) for the signed-in account.
class AssistantApi {
  AssistantApi(this._dio);

  final Dio _dio;

  /// Gemini plus, for spoken messages, speech to text on the server.
  static const _slow = Duration(seconds: 90);

  Future<AssistantReply> send(String text) async {
    final response = await _dio.post<Map<String, dynamic>>(
      '/assistant/message',
      data: {'text': text},
      options: Options(receiveTimeout: _slow),
    );
    return AssistantReply.fromJson(response.data!);
  }

  Future<AssistantReply> sendVoice(Uint8List wav) async {
    final form = FormData()
      ..files.add(MapEntry(
        'audio',
        MultipartFile.fromBytes(wav, filename: 'command.wav', contentType: DioMediaType('audio', 'wav')),
      ));
    final response = await _dio.post<Map<String, dynamic>>(
      '/assistant/voice',
      data: form,
      options: Options(receiveTimeout: _slow, sendTimeout: _slow),
    );
    return AssistantReply.fromJson(response.data!);
  }

  /// Runs a command that waited for confirmation ([reauthToken] when it needs the password).
  Future<({String reply, AssistantAction action})> confirm(String pendingId, {String? reauthToken}) async {
    final response = await _dio.post<Map<String, dynamic>>(
      '/assistant/confirm',
      data: {'pending_id': pendingId},
      options: Options(headers: {if (reauthToken != null) 'x-reauth-token': reauthToken}),
    );
    final data = response.data!;
    return (
      reply: data['reply']?.toString() ?? '',
      action: AssistantAction.fromJson(Map<String, dynamic>.from(data['action'] as Map)),
    );
  }

  /// Creates a drafted scene/automation; returns the reply and what was created.
  Future<({String reply, String? sceneId, String? automationId})> saveDraft(String draftId, {required String timezone}) async {
    final response = await _dio.post<Map<String, dynamic>>(
      '/assistant/drafts/${Uri.encodeComponent(draftId)}/save',
      data: {'timezone': timezone},
    );
    final data = response.data!;
    return (
      reply: data['reply']?.toString() ?? '',
      sceneId: data['scene_id']?.toString(),
      automationId: data['automation_id']?.toString(),
    );
  }

  /// Forgets the conversation (the server keeps the last few messages for 15 minutes).
  Future<void> reset() async {
    await _dio.delete<void>('/assistant/conversation');
  }

  Future<AssistantUsage> usage() async {
    final response = await _dio.get<Map<String, dynamic>>('/assistant/usage');
    return AssistantUsage.fromJson(response.data!);
  }
}
