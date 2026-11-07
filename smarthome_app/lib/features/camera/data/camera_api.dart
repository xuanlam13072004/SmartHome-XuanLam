import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/dio_provider.dart';

/// Error with a backend or camera reason code (for example `CAMERA_UNAVAILABLE`).
class CameraApiException implements Exception {
  const CameraApiException(this.code, [this.message]);

  final String code;
  final String? message;

  @override
  String toString() => message ?? code;
}

/// An open media session on the relay (live view or playback).
class CameraMediaSession {
  const CameraMediaSession({
    required this.mac,
    required this.sessionId,
    required this.playlistUrl,
    required this.expiresAt,
    this.details = const {},
  });

  final String mac;
  final String sessionId;

  /// `<resource_locator><access_token>/index.m3u8` (camera contract 7.1).
  final String playlistUrl;
  final DateTime expiresAt;
  final Map<String, dynamic> details;
}

/// One continuous recording interval reported by `list_recordings`.
class RecordingRange {
  const RecordingRange(this.start, this.end);

  final DateTime start;
  final DateTime end;

  Duration get duration => end.difference(start);
}

final cameraApiProvider = Provider.autoDispose<CameraApi>(
  (ref) => CameraApi(ref.watch(dioProvider)),
);

/// Camera calls of the API Gateway. Video itself never goes through the
/// Gateway: the app gets a session and plays HLS from the media relay.
class CameraApi {
  CameraApi(this._dio);

  final Dio _dio;

  static const _terminalOperationStates = {
    'succeeded',
    'rejected',
    'failed',
    'timed_out',
    'cancelled',
  };

  String _mac(String mac) => Uri.encodeComponent(mac.trim().toUpperCase());

  Future<T> _guard<T>(Future<T> Function() call) async {
    try {
      return await call();
    } on DioException catch (error) {
      final data = error.response?.data;
      if (data is Map && data['error'] is Map) {
        final backend = data['error'] as Map;
        throw CameraApiException(
          backend['code']?.toString() ?? 'REQUEST_FAILED',
          backend['message']?.toString(),
        );
      }
      rethrow;
    }
  }

  /// Opens a resource session and waits until the camera acknowledged it.
  Future<CameraMediaSession> openSession(
    String mac, {
    required String instanceId,
    required String resourceId,
    Map<String, dynamic> input = const {},
    Duration timeout = const Duration(seconds: 20),
  }) =>
      _guard(() async {
        final response = await _dio.post<Map<String, dynamic>>(
          '/devices/${_mac(mac)}/resources/'
          '${Uri.encodeComponent(instanceId)}/${Uri.encodeComponent(resourceId)}/sessions',
          data: {'input': input},
        );
        final created = Map<String, dynamic>.from(
          response.data?['session'] as Map? ?? const {},
        );
        final sessionId = created['session_id']?.toString() ?? '';
        final accessToken = created['access_token']?.toString() ?? '';
        if (sessionId.isEmpty || accessToken.isEmpty) {
          throw const CameraApiException('RESOURCE_SESSION_NOT_FOUND');
        }
        final deadline = DateTime.now().add(timeout);
        while (DateTime.now().isBefore(deadline)) {
          await Future<void>.delayed(const Duration(milliseconds: 350));
          final statusResponse = await _dio.get<Map<String, dynamic>>(
            '/devices/${_mac(mac)}/resource-sessions/${Uri.encodeComponent(sessionId)}',
          );
          final session = Map<String, dynamic>.from(
            statusResponse.data?['session'] as Map? ?? const {},
          );
          final status = session['status']?.toString();
          if (status == 'ready') {
            final locator = session['resource_locator']?.toString() ?? '';
            if (!locator.startsWith('http')) {
              throw const CameraApiException('MEDIA_RELAY_NOT_CONFIGURED');
            }
            return CameraMediaSession(
              mac: mac,
              sessionId: sessionId,
              playlistUrl: '$locator$accessToken/index.m3u8',
              expiresAt: DateTime.tryParse(session['expires_at']?.toString() ?? '') ??
                  DateTime.now().add(const Duration(minutes: 4)),
            );
          }
          if (status == 'failed' || status == 'expired' || status == 'revoked') {
            throw CameraApiException(
              session['reason_code']?.toString() ?? 'RESOURCE_SESSION_INACTIVE',
            );
          }
        }
        try {
          await closeSession(mac, sessionId);
        } catch (_) {
          // The session expires on its own; the timeout below is the real error.
        }
        throw const CameraApiException('MEDIA_INGEST_FAILED');
      });

  Future<DateTime> renewSession(String mac, String sessionId) => _guard(() async {
        final response = await _dio.post<Map<String, dynamic>>(
          '/devices/${_mac(mac)}/resource-sessions/${Uri.encodeComponent(sessionId)}/renew',
          data: const <String, dynamic>{},
        );
        final session = response.data?['session'] as Map? ?? const {};
        return DateTime.tryParse(session['expires_at']?.toString() ?? '') ??
            DateTime.now().add(const Duration(minutes: 4));
      });

  Future<void> closeSession(String mac, String sessionId) => _guard(() async {
        await _dio.delete<dynamic>(
          '/devices/${_mac(mac)}/resource-sessions/${Uri.encodeComponent(sessionId)}',
        );
      });

  /// Runs a device operation and waits for the camera's result (bounded JSON).
  Future<Map<String, dynamic>> runOperation(
    String mac, {
    required String instanceId,
    required String operationName,
    Map<String, dynamic> input = const {},
    Duration timeout = const Duration(seconds: 35),
  }) =>
      _guard(() async {
        final response = await _dio.post<Map<String, dynamic>>(
          '/devices/${_mac(mac)}/operations',
          data: {
            'instance_id': instanceId,
            'operation_name': operationName,
            'input': input,
            'idempotency_key':
                '${DateTime.now().microsecondsSinceEpoch}-$instanceId-$operationName',
          },
        );
        final operationId = response.data?['operation_id']?.toString() ?? '';
        if (operationId.isEmpty) throw const CameraApiException('OPERATION_NOT_FOUND');
        final deadline = DateTime.now().add(timeout);
        while (DateTime.now().isBefore(deadline)) {
          await Future<void>.delayed(const Duration(milliseconds: 400));
          final statusResponse = await _dio.get<Map<String, dynamic>>(
            '/devices/${_mac(mac)}/operations/${Uri.encodeComponent(operationId)}',
          );
          final operation = Map<String, dynamic>.from(
            statusResponse.data?['operation'] as Map? ?? const {},
          );
          final status = operation['status']?.toString() ?? '';
          if (!_terminalOperationStates.contains(status)) continue;
          if (status == 'succeeded') {
            return Map<String, dynamic>.from(operation['result'] as Map? ?? const {});
          }
          throw CameraApiException(
            operation['reason_code']?.toString() ?? 'DEVICE_OPERATION_REJECTED',
          );
        }
        throw const CameraApiException('DEVICE_OFFLINE');
      });

  /// All recording intervals between [from] and [to] (follows cursors).
  Future<List<RecordingRange>> listRecordings(
    String mac, {
    required String instanceId,
    required DateTime from,
    required DateTime to,
  }) async {
    final ranges = <RecordingRange>[];
    String? cursor;
    for (var page = 0; page < 10; page++) {
      final result = await runOperation(
        mac,
        instanceId: instanceId,
        operationName: 'list_recordings',
        input: {
          'from': from.toUtc().toIso8601String(),
          'to': to.toUtc().toIso8601String(),
          if (cursor != null) 'cursor': cursor,
        },
      );
      for (final raw in (result['ranges'] as List? ?? const [])) {
        if (raw is! Map) continue;
        final start = DateTime.tryParse(raw['start']?.toString() ?? '');
        final end = DateTime.tryParse(raw['end']?.toString() ?? '');
        if (start != null && end != null && end.isAfter(start)) {
          ranges.add(RecordingRange(start.toLocal(), end.toLocal()));
        }
      }
      cursor = result['next_cursor']?.toString();
      if (cursor == null || cursor.isEmpty) break;
    }
    return ranges;
  }

  /// Deletes recordings overlapping [from, to), or everything when [all].
  Future<({int deletedSegments, int freedBytes})> deleteRecordings(
    String mac, {
    required String instanceId,
    DateTime? from,
    DateTime? to,
    bool all = false,
  }) async {
    final result = await runOperation(
      mac,
      instanceId: instanceId,
      operationName: 'delete_recordings',
      input: {
        if (all) 'all': true,
        if (!all && from != null) 'from': from.toUtc().toIso8601String(),
        if (!all && to != null) 'to': to.toUtc().toIso8601String(),
      },
    );
    return (
      deletedSegments: (result['deleted_segments'] as num?)?.toInt() ?? 0,
      freedBytes: (result['freed_bytes'] as num?)?.toInt() ?? 0,
    );
  }
}
