import 'dart:convert';

/// One media segment of an HLS media playlist, placed on the player's
/// timeline (seconds from the start) and, when the playlist says so, on the
/// wall clock (`#EXT-X-PROGRAM-DATE-TIME`).
class HlsFragment {
  const HlsFragment({required this.start, required this.duration, this.programDateTime});

  final double start;
  final double duration;
  final DateTime? programDateTime;
}

/// Segments of a media playlist in order. A master playlist (or anything that
/// is not HLS) gives an empty list.
List<HlsFragment> parseHlsFragments(String playlist) {
  final fragments = <HlsFragment>[];
  var position = 0.0;
  DateTime? programDateTime;
  double? duration;
  for (final raw in const LineSplitter().convert(playlist)) {
    final line = raw.trim();
    if (line.isEmpty) continue;
    if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      programDateTime = DateTime.tryParse(line.substring(line.indexOf(':') + 1));
    } else if (line.startsWith('#EXTINF:')) {
      duration = double.tryParse(line.substring(8).split(',').first.trim());
    } else if (!line.startsWith('#') && duration != null) {
      fragments.add(HlsFragment(start: position, duration: duration, programDateTime: programDateTime));
      position += duration;
      // A segment without its own tag continues from the previous one.
      programDateTime = programDateTime?.add(Duration(microseconds: (duration * 1e6).round()));
      duration = null;
    }
  }
  return fragments;
}

/// Player position (seconds) showing wall-clock [time]. Before the first
/// recording it is the start; in a gap between recordings it is where the
/// next recording begins (the player timeline has no gaps).
double? positionForWallTime(List<HlsFragment> fragments, DateTime time) {
  final target = time.millisecondsSinceEpoch;
  double? position;
  for (final fragment in fragments) {
    final pdt = fragment.programDateTime?.millisecondsSinceEpoch;
    if (pdt == null) continue;
    if (pdt <= target) {
      position = fragment.start + ((target - pdt) / 1000).clamp(0.0, fragment.duration);
    } else {
      return position ?? fragment.start;
    }
  }
  return position;
}

/// Wall-clock time of the frame at player [position] (seconds).
DateTime? wallTimeAtPosition(List<HlsFragment> fragments, double position) {
  for (var index = 0; index < fragments.length; index++) {
    final fragment = fragments[index];
    final last = index == fragments.length - 1;
    if (position < fragment.start + fragment.duration || last) {
      final pdt = fragment.programDateTime;
      if (pdt == null) return null;
      final offset = (position - fragment.start).clamp(0.0, fragment.duration);
      return pdt.add(Duration(microseconds: (offset * 1e6).round()));
    }
  }
  return null;
}
