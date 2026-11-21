/// Voice profile ("Giọng nói") data from GET/POST /voice/….
library;

Map<String, dynamic> _map(Object? value) =>
    value is Map ? Map<String, dynamic>.from(value) : <String, dynamic>{};

double? _double(Object? value) => value is num ? value.toDouble() : null;

int _int(Object? value) => value is num ? value.toInt() : 0;

DateTime? _time(Object? value) => value is String ? DateTime.tryParse(value)?.toLocal() : null;

/// The temporary lock after repeated failed verifications.
class VoiceLock {
  const VoiceLock({this.lockedUntil, this.failuresLeft = 5});

  final DateTime? lockedUntil;
  final int failuresLeft;

  bool get locked => lockedUntil != null && lockedUntil!.isAfter(DateTime.now());

  factory VoiceLock.fromJson(Map<String, dynamic> json) => VoiceLock(
        lockedUntil: _time(json['locked_until']),
        failuresLeft: _int(json['failures_left']),
      );
}

class VoiceThresholds {
  const VoiceThresholds({
    required this.mode,
    required this.speaker,
    required this.norm,
    required this.fusion,
    this.antiSpoof,
  });

  /// `as_norm` (score normalization against a cohort) or `cosine`.
  final String mode;
  final double speaker;
  final double norm;
  final double fusion;
  final double? antiSpoof;

  bool get normalized => mode == 'as_norm';

  factory VoiceThresholds.fromJson(Map<String, dynamic> json) => VoiceThresholds(
        mode: json['mode']?.toString() ?? 'cosine',
        speaker: _double(json['speaker']) ?? 0.68,
        norm: _double(json['norm']) ?? 3,
        fusion: _double(json['fusion']) ?? 0.64,
        antiSpoof: _double(json['anti_spoof']),
      );
}

class VoiceProfile {
  const VoiceProfile({
    required this.createdAt,
    required this.calibratedAt,
    required this.noiseFloorDb,
    required this.thresholds,
    required this.enrollTemplates,
    required this.sampleTemplates,
    required this.autoTemplates,
    required this.maxTemplates,
    required this.antiSpoofVersion,
    required this.antiSpoofTrainedAt,
    required this.antiSpoofTraining,
    required this.spoofClips,
    required this.maxSpoofClips,
    required this.antiSpoofWeak,
    required this.acceptedRecently,
    required this.rejectedRecently,
  });

  final DateTime? createdAt;
  final DateTime? calibratedAt;
  final double noiseFloorDb;
  final VoiceThresholds thresholds;
  final int enrollTemplates;
  final int sampleTemplates;
  final int autoTemplates;
  final int maxTemplates;
  final int antiSpoofVersion;
  final DateTime? antiSpoofTrainedAt;

  /// The anti-spoof model is being retrained in the background.
  final bool antiSpoofTraining;
  final int spoofClips;
  final int maxSpoofClips;

  /// The anti-spoof model barely separates live voice from replays yet.
  final bool antiSpoofWeak;
  final int acceptedRecently;
  final int rejectedRecently;

  int get templates => enrollTemplates + sampleTemplates + autoTemplates;

  factory VoiceProfile.fromJson(Map<String, dynamic> json) {
    final templates = _map(json['templates']);
    final antiSpoof = _map(json['anti_spoof']);
    final attempts = _map(json['attempts_30d']);
    return VoiceProfile(
      createdAt: _time(json['created_at']),
      calibratedAt: _time(json['calibrated_at']),
      noiseFloorDb: _double(json['noise_floor_db']) ?? -60,
      thresholds: VoiceThresholds.fromJson(_map(json['thresholds'])),
      enrollTemplates: _int(templates['enroll']),
      sampleTemplates: _int(templates['sample']),
      autoTemplates: _int(templates['auto']),
      maxTemplates: _int(templates['max']),
      antiSpoofVersion: _int(antiSpoof['version']),
      antiSpoofTrainedAt: _time(antiSpoof['trained_at']),
      antiSpoofTraining: antiSpoof['training'] == true,
      spoofClips: _int(antiSpoof['spoof_clips']),
      maxSpoofClips: _int(antiSpoof['max_spoof_clips']),
      antiSpoofWeak: antiSpoof['weak'] == true,
      acceptedRecently: _int(attempts['accepted']),
      rejectedRecently: _int(attempts['rejected']),
    );
  }
}

/// GET /voice/profile: the profile (null before enrollment) and the lock.
class VoiceState {
  const VoiceState({required this.profile, required this.lock});

  final VoiceProfile? profile;
  final VoiceLock lock;

  factory VoiceState.fromJson(Map<String, dynamic> json) => VoiceState(
        profile: json['profile'] is Map ? VoiceProfile.fromJson(_map(json['profile'])) : null,
        lock: VoiceLock.fromJson(_map(json['lock'])),
      );
}

class VoiceScores {
  const VoiceScores({
    required this.similarity,
    required this.normalized,
    required this.antiSpoof,
    required this.fusion,
    required this.snrDb,
  });

  final double similarity;
  final double? normalized;
  final double antiSpoof;
  final double fusion;
  final double snrDb;

  factory VoiceScores.fromJson(Map<String, dynamic> json) => VoiceScores(
        similarity: _double(json['similarity']) ?? 0,
        normalized: _double(json['normalized']),
        antiSpoof: _double(json['anti_spoof']) ?? 0,
        fusion: _double(json['fusion']) ?? 0,
        snrDb: _double(json['snr_db']) ?? 0,
      );
}

class VoiceVerification {
  const VoiceVerification({
    required this.accepted,
    required this.reason,
    required this.scores,
    required this.thresholds,
    required this.galleryUpdated,
    required this.lock,
  });

  final bool accepted;

  /// not_matched · spoof_suspected · low_confidence
  final String? reason;
  final VoiceScores scores;
  final VoiceThresholds thresholds;
  final bool galleryUpdated;
  final VoiceLock lock;

  factory VoiceVerification.fromJson(Map<String, dynamic> json) {
    final result = _map(json['result']);
    return VoiceVerification(
      accepted: result['accepted'] == true,
      reason: result['reason']?.toString(),
      scores: VoiceScores.fromJson(_map(result['scores'])),
      thresholds: VoiceThresholds.fromJson(_map(result['thresholds'])),
      galleryUpdated: result['gallery_updated'] == true,
      lock: VoiceLock.fromJson(_map(json['lock'])),
    );
  }
}
