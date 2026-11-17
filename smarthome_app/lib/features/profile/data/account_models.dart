/// The signed-in user's profile (GET /me → `user`).
class AccountProfile {
  const AccountProfile({
    required this.id,
    required this.email,
    required this.fullName,
    required this.createdAt,
  });

  final String id;
  final String email;
  final String fullName;
  final DateTime createdAt;

  factory AccountProfile.fromJson(Map<String, dynamic> json) => AccountProfile(
        id: json['id'] as String,
        email: json['email'] as String,
        fullName: json['full_name'] as String,
        createdAt: DateTime.parse(json['created_at'] as String).toLocal(),
      );

  String get initials => initialsOf(fullName);
}

/// Up to two letters from the last two words: "Nguyễn Xuân Lâm" → "XL".
String initialsOf(String fullName) {
  final words = fullName.trim().split(RegExp(r'\s+')).where((w) => w.isNotEmpty).toList();
  if (words.isEmpty) return '?';
  final picked = words.length == 1 ? words : words.sublist(words.length - 2);
  return picked.map((w) => String.fromCharCode(w.runes.first).toUpperCase()).join();
}

/// Counters shown under the profile header.
class AccountStats {
  const AccountStats({
    required this.ownedDevices,
    required this.sharedDevices,
    required this.pendingInvites,
  });

  final int ownedDevices;
  final int sharedDevices;
  final int pendingInvites;

  factory AccountStats.fromJson(Map<String, dynamic> json) => AccountStats(
        ownedDevices: (json['owned_devices'] as num?)?.toInt() ?? 0,
        sharedDevices: (json['shared_devices'] as num?)?.toInt() ?? 0,
        pendingInvites: (json['pending_invites'] as num?)?.toInt() ?? 0,
      );
}

class AccountOverview {
  const AccountOverview({required this.user, required this.stats});

  final AccountProfile user;
  final AccountStats stats;

  factory AccountOverview.fromJson(Map<String, dynamic> json) => AccountOverview(
        user: AccountProfile.fromJson(json['user'] as Map<String, dynamic>),
        stats: AccountStats.fromJson(json['stats'] as Map<String, dynamic>? ?? const {}),
      );
}

/// One signed-in device (GET /me/sessions).
class LoginSession {
  const LoginSession({
    required this.id,
    required this.platform,
    required this.name,
    required this.createdAt,
    required this.lastActiveAt,
    required this.current,
  });

  final String id;
  final String platform;
  final String? name;
  final DateTime createdAt;
  final DateTime lastActiveAt;
  final bool current;

  factory LoginSession.fromJson(Map<String, dynamic> json) => LoginSession(
        id: json['id'] as String,
        platform: json['platform'] as String? ?? 'unknown',
        name: json['name'] as String?,
        createdAt: DateTime.parse(json['created_at'] as String).toLocal(),
        lastActiveAt: DateTime.parse(json['last_active_at'] as String).toLocal(),
        current: json['current'] == true,
      );

  String get displayName => name ?? switch (platform) {
        'web' => 'Trình duyệt web',
        'android' => 'Thiết bị Android',
        'ios' => 'iPhone / iPad',
        'windows' => 'Máy tính Windows',
        'macos' => 'Máy Mac',
        'linux' => 'Máy tính Linux',
        _ => 'Thiết bị không xác định',
      };
}
