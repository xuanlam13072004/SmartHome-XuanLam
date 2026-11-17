import 'package:dio/dio.dart';

import '../../notifications/data/notification_models.dart' show CursorPage;
import 'scene_models.dart';

/// Scene endpoints of the API Gateway.
class ScenesApi {
  ScenesApi(this._dio);

  final Dio _dio;

  String _id(String id) => Uri.encodeComponent(id);

  Future<SceneList> fetchScenes() async {
    final response = await _dio.get<Map<String, dynamic>>('/scenes');
    return SceneList.fromJson(response.data!);
  }

  /// The caller's devices with the operations a step may use.
  Future<List<SceneActionDevice>> fetchActions() async {
    final response = await _dio.get<Map<String, dynamic>>('/scenes/actions');
    return (response.data!['devices'] as List)
        .map((item) => SceneActionDevice.fromJson(Map<String, dynamic>.from(item as Map)))
        .toList(growable: false);
  }

  Future<Scene> createScene({required String name, required String icon, required List<SceneStep> steps}) async {
    final response = await _dio.post<Map<String, dynamic>>('/scenes', data: {
      'name': name,
      'icon': icon,
      'steps': steps.map((step) => step.toJson()).toList(),
    });
    return Scene.fromJson(Map<String, dynamic>.from(response.data!['scene'] as Map));
  }

  Future<Scene> updateScene(String id, {String? name, String? icon, List<SceneStep>? steps}) async {
    final response = await _dio.patch<Map<String, dynamic>>('/scenes/${_id(id)}', data: {
      if (name != null) 'name': name,
      if (icon != null) 'icon': icon,
      if (steps != null) 'steps': steps.map((step) => step.toJson()).toList(),
    });
    return Scene.fromJson(Map<String, dynamic>.from(response.data!['scene'] as Map));
  }

  Future<void> deleteScene(String id) async {
    await _dio.delete<void>('/scenes/${_id(id)}');
  }

  Future<void> reorder(List<String> sceneIds) async {
    await _dio.put<void>('/scenes/order', data: {'scene_ids': sceneIds});
  }

  Future<SceneSchedule> createSchedule(
    String sceneId, {
    required String time,
    required List<int> days,
    required String timezone,
  }) async {
    final response = await _dio.post<Map<String, dynamic>>('/scenes/${_id(sceneId)}/schedules', data: {
      'time': time,
      'days': days,
      'timezone': timezone,
    });
    return SceneSchedule.fromJson(Map<String, dynamic>.from(response.data!['schedule'] as Map));
  }

  Future<SceneSchedule> updateSchedule(
    String id, {
    String? time,
    List<int>? days,
    String? timezone,
    bool? enabled,
  }) async {
    final response = await _dio.patch<Map<String, dynamic>>('/scene-schedules/${_id(id)}', data: {
      if (time != null) 'time': time,
      if (days != null) 'days': days,
      if (timezone != null) 'timezone': timezone,
      if (enabled != null) 'enabled': enabled,
    });
    return SceneSchedule.fromJson(Map<String, dynamic>.from(response.data!['schedule'] as Map));
  }

  Future<void> deleteSchedule(String id) async {
    await _dio.delete<void>('/scene-schedules/${_id(id)}');
  }

  /// [reauthToken] is required when the scene has a protected step.
  Future<SceneRun> run(String id, {String? reauthToken}) async {
    final response = await _dio.post<Map<String, dynamic>>(
      '/scenes/${_id(id)}/run',
      options: reauthToken == null ? null : Options(headers: {'x-reauth-token': reauthToken}),
    );
    return SceneRun.fromJson(Map<String, dynamic>.from(response.data!['run'] as Map));
  }

  Future<CursorPage<SceneRun>> fetchRuns({String? before, String? sceneId}) async {
    final response = await _dio.get<Map<String, dynamic>>('/scene-runs', queryParameters: {
      if (before != null) 'before': before,
      if (sceneId != null) 'scene_id': sceneId,
    });
    final data = response.data!;
    return CursorPage(
      (data['runs'] as List)
          .map((item) => SceneRun.fromJson(Map<String, dynamic>.from(item as Map)))
          .toList(growable: false),
      data['next_cursor'] as String?,
    );
  }

  Future<SceneRun> fetchRun(String runId) async {
    final response = await _dio.get<Map<String, dynamic>>('/scene-runs/${_id(runId)}');
    return SceneRun.fromJson(Map<String, dynamic>.from(response.data!['run'] as Map));
  }
}
