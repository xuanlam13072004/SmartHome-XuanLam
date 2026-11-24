import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/dio_provider.dart';
import '../data/weather_api.dart';
import '../data/weather_models.dart';

final weatherApiProvider = Provider.autoDispose<WeatherApi>(
  (ref) => WeatherApi(ref.watch(dioProvider)),
);

/// The home location and its forecast. Read again every 30 minutes while
/// shown (the server refreshes forecasts on the same rhythm).
final homeWeatherProvider = FutureProvider.autoDispose<HomeWeather>((ref) {
  final timer = Timer(const Duration(minutes: 30), ref.invalidateSelf);
  ref.onDispose(timer.cancel);
  return ref.watch(weatherApiProvider).fetchWeather();
});

/// The 34 provinces and cities a home can be placed in.
final provincesProvider = FutureProvider.autoDispose<List<Province>>(
  (ref) => ref.watch(weatherApiProvider).fetchProvinces(),
);
