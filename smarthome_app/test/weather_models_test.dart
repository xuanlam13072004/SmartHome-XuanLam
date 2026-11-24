import 'package:flutter_test/flutter_test.dart';
import 'package:smarthome_app/features/automations/automation_labels.dart';
import 'package:smarthome_app/features/automations/data/automation_models.dart';
import 'package:smarthome_app/features/weather/data/weather_models.dart';

void main() {
  test('the weather at home, as GET /weather returns it', () {
    final home = HomeWeather.fromJson({
      'success': true,
      'enabled': true,
      'mode': 'mock',
      'location': {'latitude': 21.03, 'longitude': 105.85, 'place': 'Hà Nội'},
      'weather': {
        'source': 'mock',
        'updated_at': '2026-11-23T13:14:00.000Z',
        'current': {'temperature': 28, 'raining': false, 'description': 'Nhiều mây'},
        'today': {'max': 30, 'min': 24},
        'rain_in_hours': 2,
        'next_hours': [
          {'at': '2026-11-23T13:00:00.000Z', 'temperature': 28, 'precipitation_probability': 10, 'rain': false},
          {'at': '2026-11-23T15:00:00.000Z', 'temperature': 26.6, 'precipitation_probability': 90, 'rain': true},
        ],
      },
      'attribution': 'Thời tiết giả lập (thử nghiệm)',
    });
    expect(home.enabled, isTrue);
    expect(home.location!.place, 'Hà Nội');
    final weather = home.weather!;
    expect(weather.isMock, isTrue);
    expect([weather.temperature, weather.todayMin, weather.todayMax], [28, 24, 30]);
    expect(weather.nextHours[1].temperature, 27);
    expect(weather.nextHours[1].rain, isTrue);
    expect(weather.rainText, 'Có thể mưa trong khoảng 2 giờ tới');

    final off = HomeWeather.fromJson({'success': true, 'enabled': false, 'location': null, 'weather': null});
    expect(off.enabled, isFalse);
    expect(off.location, isNull);
  });

  test('a searched place keeps its province in the name', () {
    final place = PlaceResult.fromJson({'name': 'Ba Đình', 'detail': 'Hà Nội', 'latitude': 21.03, 'longitude': 105.81});
    expect(place.fullName, 'Ba Đình, Hà Nội');
    final province = PlaceResult.fromJson(
        {'name': 'Huế', 'detail': 'Tỉnh/thành phố', 'latitude': 16.46, 'longitude': 107.59});
    expect(province.fullName, 'Huế');
  });

  test('a weather condition is saved and shown as one', () {
    final device = AutomationDevice.weather('Hà Nội', [
      AutomationProperty.fromJson({
        'property': 'weather.rain_next_12h',
        'instance_label': 'Thời tiết',
        'label': 'Có mưa trong 12 giờ tới',
        'kind': 'boolean',
        'operators': ['eq'],
      }),
    ]);
    expect(device.isWeather, isTrue);
    final condition = StateComparison.of(device, device.conditions.first, 'eq', false);
    expect(condition.toJson(), {'weather': 'rain_next_12h', 'operator': 'eq', 'value': false});
    expect(AutomationLabels.comparison(condition), 'Không mưa trong 12 giờ tới');

    final stored = StateComparison.fromJson({
      'kind': 'weather',
      'device': null,
      'property': 'weather.temperature',
      'label': 'Nhiệt độ ngoài trời',
      'operator': 'gt',
      'value': 35,
      'unit': 'celsius',
      'available': false,
    });
    expect(stored.weather, 'temperature');
    expect(stored.deviceName, 'Thời tiết');
    expect(stored.available, isFalse);
    expect(AutomationLabels.comparison(stored), 'Nhiệt độ ngoài trời trên 35°C');
    expect(
      AutomationLabels.lastResult('skipped_conditions', DateTime.now(), skipReason: 'weather_unavailable'),
      startsWith('Không chạy'),
    );
  });
}
