import 'package:dio/dio.dart';

import 'automation_models.dart';

/// Automation endpoints of the API Gateway.
class AutomationsApi {
  AutomationsApi(this._dio);

  final Dio _dio;

  String _id(String id) => Uri.encodeComponent(id);

  Automation _automation(Response<Map<String, dynamic>> response) =>
      Automation.fromJson(Map<String, dynamic>.from(response.data!['automation'] as Map));

  Future<AutomationList> fetchAutomations() async {
    final response = await _dio.get<Map<String, dynamic>>('/automations');
    return AutomationList.fromJson(response.data!);
  }

  /// The caller's devices with the states and events an automation may use,
  /// then the weather at home (conditions only) once a home location is set.
  Future<List<AutomationDevice>> fetchOptions() async {
    final response = await _dio.get<Map<String, dynamic>>('/automations/options');
    final devices = (response.data!['devices'] as List)
        .map((item) => AutomationDevice.fromJson(Map<String, dynamic>.from(item as Map)))
        .toList();
    final weather = response.data!['weather'];
    if (weather is Map && weather['place'] is String) {
      devices.add(AutomationDevice.weather(
        weather['place'] as String,
        (weather['conditions'] as List? ?? const [])
            .map((item) => AutomationProperty.fromJson(Map<String, dynamic>.from(item as Map)))
            .toList(growable: false),
      ));
    }
    return List.unmodifiable(devices);
  }

  Future<List<AutomationSuggestion>> fetchSuggestions() async {
    final response = await _dio.get<Map<String, dynamic>>('/automations/suggestions');
    return (response.data!['suggestions'] as List)
        .map((item) => AutomationSuggestion.fromJson(Map<String, dynamic>.from(item as Map)))
        .toList(growable: false);
  }

  Future<Automation> applySuggestion(String key, {required String timezone}) async {
    final response = await _dio.post<Map<String, dynamic>>(
      '/automations/suggestions/apply',
      data: {'key': key, 'timezone': timezone},
    );
    return _automation(response);
  }

  Future<Automation> create(AutomationDraft draft) async =>
      _automation(await _dio.post<Map<String, dynamic>>('/automations', data: draft.toJson()));

  Future<Automation> replace(String id, AutomationDraft draft) async =>
      _automation(await _dio.put<Map<String, dynamic>>('/automations/${_id(id)}', data: draft.toJson()));

  Future<Automation> setEnabled(String id, bool enabled) async =>
      _automation(await _dio.patch<Map<String, dynamic>>('/automations/${_id(id)}', data: {'enabled': enabled}));

  Future<void> delete(String id) async {
    await _dio.delete<void>('/automations/${_id(id)}');
  }
}
