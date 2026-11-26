import 'package:dio/dio.dart';

import 'weather_models.dart';

/// Weather endpoints of the API Gateway (docs/architecture/weather.md).
class WeatherApi {
  WeatherApi(this._dio);

  final Dio _dio;

  Future<HomeWeather> fetchWeather() async {
    final response = await _dio.get<Map<String, dynamic>>('/weather');
    return HomeWeather.fromJson(response.data!);
  }

  Future<List<Province>> fetchProvinces() async {
    final response = await _dio.get<Map<String, dynamic>>('/weather/provinces');
    return (response.data!['provinces'] as List)
        .map((item) => Province.fromJson(Map<String, dynamic>.from(item as Map)))
        .toList(growable: false);
  }

  /// Puts the home in [area]; returns the home as the server names it.
  Future<HomeLocation> setArea(String area) async {
    final response = await _dio.put<Map<String, dynamic>>('/me/home-location', data: {'area': area});
    return HomeLocation.fromJson(Map<String, dynamic>.from(response.data!['location'] as Map));
  }

  Future<void> clearLocation() async {
    await _dio.delete<void>('/me/home-location');
  }
}
