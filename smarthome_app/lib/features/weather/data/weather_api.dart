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

  Future<List<PlaceResult>> searchPlaces(String query) async {
    final response = await _dio.get<Map<String, dynamic>>('/weather/places', queryParameters: {'q': query});
    return (response.data!['places'] as List)
        .map((item) => PlaceResult.fromJson(Map<String, dynamic>.from(item as Map)))
        .toList(growable: false);
  }

  Future<void> setProvince(String code) async {
    await _dio.put<void>('/me/home-location', data: {'province': code});
  }

  Future<void> setPlace(PlaceResult place) async {
    await _dio.put<void>('/me/home-location', data: {
      'place': {'name': place.fullName, 'latitude': place.latitude, 'longitude': place.longitude},
    });
  }

  Future<void> clearLocation() async {
    await _dio.delete<void>('/me/home-location');
  }
}
