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
      'location': {
        'area': 'binh_duong',
        'province': 'ho_chi_minh',
        'place': 'Bình Dương (TP. Hồ Chí Minh)',
        'latitude': 10.98,
        'longitude': 106.65,
      },
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
      'attribution': {'text': 'Thời tiết giả lập (thử nghiệm)', 'url': null},
    });
    expect(home.enabled, isTrue);
    expect([home.location!.area, home.location!.province, home.location!.place],
        ['binh_duong', 'ho_chi_minh', 'Bình Dương (TP. Hồ Chí Minh)']);
    expect(home.attribution!.text, 'Thời tiết giả lập (thử nghiệm)');
    expect(home.attribution!.url, isNull);
    final weather = home.weather!;
    expect(weather.isMock, isTrue);
    expect([weather.temperature, weather.todayMin, weather.todayMax], [28, 24, 30]);
    expect(weather.nextHours[1].temperature, 27);
    expect(weather.nextHours[1].rain, isTrue);
    expect(weather.rainText, 'Có thể mưa trong khoảng 2 giờ tới');

    final off = HomeWeather.fromJson({'success': true, 'enabled': false, 'location': null, 'weather': null});
    expect(off.enabled, isFalse);
    expect(off.location, isNull);
    expect(off.attribution, isNull);
  });

  test('Open-Meteo is credited with a link; only https links are opened', () {
    final live = WeatherAttribution.fromJson({'text': 'Dữ liệu thời tiết: Open-Meteo.com (CC BY 4.0)', 'url': 'https://open-meteo.com/'})!;
    expect(live.url, Uri.parse('https://open-meteo.com/'));
    expect(WeatherAttribution.fromJson({'text': 'x', 'url': 'javascript:alert(1)'})!.url, isNull);
    expect(WeatherAttribution.fromJson('Dữ liệu thời tiết: Open-Meteo.com (CC BY 4.0)')!.url, isNull, reason: 'an older server');
  });

  test('a province with its areas: merged ones ask which area', () {
    final merged = Province.fromJson({
      'code': 'ho_chi_minh',
      'name': 'TP. Hồ Chí Minh',
      'areas': [
        {'code': 'ho_chi_minh', 'name': 'TP. Hồ Chí Minh'},
        {'code': 'binh_duong', 'name': 'Bình Dương'},
        {'code': 'ba_ria_vung_tau', 'name': 'Bà Rịa – Vũng Tàu'},
      ],
    });
    expect(merged.merged, isTrue);
    expect(merged.areas.map((area) => area.code), ['ho_chi_minh', 'binh_duong', 'ba_ria_vung_tau']);
    final single = Province.fromJson({
      'code': 'ha_noi',
      'name': 'Hà Nội',
      'areas': [
        {'code': 'ha_noi', 'name': 'Hà Nội'},
      ],
    });
    expect(single.merged, isFalse);
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
