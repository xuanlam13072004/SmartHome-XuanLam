import 'package:flutter_test/flutter_test.dart';
import 'package:smarthome_app/core/config/app_config.dart';
import 'package:smarthome_app/features/camera/player/hls_playlist.dart';

// The shape the media relay serves for recordings (playback.ts): one
// PROGRAM-DATE-TIME per segment, a discontinuity where recording stopped.
const _playlist = '''
#EXTM3U
#EXT-X-VERSION:7
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MAP:URI="rec/a/init.mp4"
#EXT-X-PROGRAM-DATE-TIME:2026-11-11T08:00:00.000Z
#EXTINF:4.000,
rec/a/media.m4s
#EXT-X-PROGRAM-DATE-TIME:2026-11-11T08:00:04.000Z
#EXTINF:4.000,
rec/b/media.m4s
#EXT-X-DISCONTINUITY
#EXT-X-MAP:URI="rec/c/init.mp4"
#EXT-X-PROGRAM-DATE-TIME:2026-11-11T09:00:00.000Z
#EXTINF:2.500,
rec/c/media.m4s
#EXT-X-ENDLIST
''';

DateTime _utc(int hour, int minute, int second, [int millis = 0]) =>
    DateTime.utc(2026, 11, 11, hour, minute, second, millis);

void main() {
  final fragments = parseHlsFragments(_playlist);

  test('segments are placed on the player timeline and the wall clock', () {
    expect(fragments.map((fragment) => fragment.start), [0, 4, 8]);
    expect(fragments.map((fragment) => fragment.duration), [4, 4, 2.5]);
    expect(fragments.last.programDateTime, _utc(9, 0, 0));
  });

  test('a wall-clock time maps to the position that shows it', () {
    expect(positionForWallTime(fragments, _utc(8, 0, 5, 500)), 5.5);
    // Before the first recording: from the start.
    expect(positionForWallTime(fragments, _utc(7, 0, 0)), 0);
    // In the gap: where the next recording begins.
    expect(positionForWallTime(fragments, _utc(8, 30, 0)), 8);
    // After the end: the end.
    expect(positionForWallTime(fragments, _utc(10, 0, 0)), 10.5);
  });

  test('a position maps back to the wall clock, across the gap', () {
    expect(wallTimeAtPosition(fragments, 1.25), _utc(8, 0, 1, 250));
    expect(wallTimeAtPosition(fragments, 9), _utc(9, 0, 1));
  });

  test('segments without their own date continue from the previous one', () {
    final continued = parseHlsFragments('''
#EXTM3U
#EXT-X-PROGRAM-DATE-TIME:2026-11-11T08:00:00Z
#EXTINF:2.0,
a.m4s
#EXTINF:2.0,
b.m4s
''');
    expect(continued[1].programDateTime, _utc(8, 0, 2));
  });

  test('a live playlist without dates has no wall-clock mapping', () {
    final live = parseHlsFragments('#EXTM3U\n#EXTINF:1.0,\nlive/1.m4s\n');
    expect(wallTimeAtPosition(live, 0.5), isNull);
    expect(positionForWallTime(live, _utc(8, 0, 0)), isNull);
  });

  test('a localhost media address is reached through the API host', () {
    // flutter_test runs as Android, so the API is the emulator's 10.0.2.2.
    expect(AppConfig.baseUrl, 'http://10.0.2.2:3000');
    expect(
      AppConfig.reachableUrl('http://localhost:8090/v1/hls/s1/token/index.m3u8'),
      'http://10.0.2.2:8090/v1/hls/s1/token/index.m3u8',
    );
    expect(
      AppConfig.reachableUrl('https://media.example.com/v1/hls/x/index.m3u8'),
      'https://media.example.com/v1/hls/x/index.m3u8',
    );
  });
}
