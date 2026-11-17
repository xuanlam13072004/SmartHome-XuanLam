/// Device sharing data (GET /me/sharing, GET /devices/:mac/members).
library;

DateTime _time(Object? value) => DateTime.parse(value as String).toLocal();

List<String> _strings(Object? value) =>
    (value as List? ?? const []).map((item) => item.toString()).toList();

class SharedDeviceRef {
  const SharedDeviceRef({required this.mac, required this.name, required this.productId});

  final String mac;
  final String name;
  final String productId;

  factory SharedDeviceRef.fromJson(Map<String, dynamic> json) => SharedDeviceRef(
        mac: json['mac'] as String,
        name: json['name'] as String,
        productId: json['product_id'] as String,
      );
}

class PersonRef {
  const PersonRef({required this.fullName, required this.email});

  final String fullName;
  final String email;

  factory PersonRef.fromJson(Map<String, dynamic> json) => PersonRef(
        fullName: json['full_name'] as String,
        email: json['email'] as String,
      );
}

/// An invitation waiting for me.
class ReceivedInvite {
  const ReceivedInvite({
    required this.id,
    required this.role,
    required this.permissions,
    required this.expiresAt,
    required this.device,
    required this.owner,
  });

  final String id;
  final String role;
  final List<String> permissions;
  final DateTime expiresAt;
  final SharedDeviceRef device;
  final PersonRef owner;

  factory ReceivedInvite.fromJson(Map<String, dynamic> json) => ReceivedInvite(
        id: json['id'] as String,
        role: json['role'] as String,
        permissions: _strings(json['permissions']),
        expiresAt: _time(json['expires_at']),
        device: SharedDeviceRef.fromJson(json['device'] as Map<String, dynamic>),
        owner: PersonRef.fromJson(json['owner'] as Map<String, dynamic>),
      );
}

/// A device someone else shares with me.
class SharedWithMe {
  const SharedWithMe({
    required this.device,
    required this.owner,
    required this.role,
    required this.permissions,
    required this.joinedAt,
  });

  final SharedDeviceRef device;
  final PersonRef owner;
  final String role;
  final List<String> permissions;
  final DateTime joinedAt;

  factory SharedWithMe.fromJson(Map<String, dynamic> json) => SharedWithMe(
        device: SharedDeviceRef.fromJson(json['device'] as Map<String, dynamic>),
        owner: PersonRef.fromJson(json['owner'] as Map<String, dynamic>),
        role: json['role'] as String,
        permissions: _strings(json['permissions']),
        joinedAt: _time(json['joined_at']),
      );
}

/// One of my devices and how widely it is shared.
class MyDeviceSharing {
  const MyDeviceSharing({required this.device, required this.memberCount, required this.pendingInvites});

  final SharedDeviceRef device;
  final int memberCount;
  final int pendingInvites;

  factory MyDeviceSharing.fromJson(Map<String, dynamic> json) => MyDeviceSharing(
        device: SharedDeviceRef.fromJson(json['device'] as Map<String, dynamic>),
        memberCount: (json['member_count'] as num?)?.toInt() ?? 0,
        pendingInvites: (json['pending_invites'] as num?)?.toInt() ?? 0,
      );
}

class SharingOverview {
  const SharingOverview({required this.invites, required this.sharedWithMe, required this.myDevices});

  final List<ReceivedInvite> invites;
  final List<SharedWithMe> sharedWithMe;
  final List<MyDeviceSharing> myDevices;

  factory SharingOverview.fromJson(Map<String, dynamic> json) => SharingOverview(
        invites: (json['invites'] as List? ?? const [])
            .map((item) => ReceivedInvite.fromJson(item as Map<String, dynamic>))
            .toList(),
        sharedWithMe: (json['shared_with_me'] as List? ?? const [])
            .map((item) => SharedWithMe.fromJson(item as Map<String, dynamic>))
            .toList(),
        myDevices: (json['my_devices'] as List? ?? const [])
            .map((item) => MyDeviceSharing.fromJson(item as Map<String, dynamic>))
            .toList(),
      );
}

/// A person with access to one of my devices.
class DeviceMember {
  const DeviceMember({
    required this.accountId,
    required this.fullName,
    required this.email,
    required this.role,
    required this.permissions,
    required this.joinedAt,
  });

  final String accountId;
  final String fullName;
  final String email;
  final String role;
  final List<String> permissions;
  final DateTime joinedAt;

  factory DeviceMember.fromJson(Map<String, dynamic> json) => DeviceMember(
        accountId: json['account_id'] as String,
        fullName: json['full_name'] as String,
        email: json['email'] as String,
        role: json['role'] as String,
        permissions: _strings(json['permissions']),
        joinedAt: _time(json['joined_at']),
      );
}

/// An invitation I sent that is still open.
class SentInvite {
  const SentInvite({
    required this.id,
    required this.email,
    required this.role,
    required this.createdAt,
    required this.expiresAt,
  });

  final String id;
  final String email;
  final String role;
  final DateTime createdAt;
  final DateTime expiresAt;

  factory SentInvite.fromJson(Map<String, dynamic> json) => SentInvite(
        id: json['id'] as String,
        email: json['email'] as String,
        role: json['role'] as String,
        createdAt: _time(json['created_at']),
        expiresAt: _time(json['expires_at']),
      );
}

class DeviceMembers {
  const DeviceMembers({
    required this.device,
    required this.members,
    required this.invites,
    required this.rolePermissions,
    required this.maxMembers,
    required this.used,
  });

  final SharedDeviceRef device;
  final List<DeviceMember> members;
  final List<SentInvite> invites;
  /// Permissions each role grants on this product: `viewer` and `controller`.
  final Map<String, List<String>> rolePermissions;
  final int maxMembers;
  final int used;

  bool get isFull => used >= maxMembers;

  factory DeviceMembers.fromJson(Map<String, dynamic> json) {
    final roles = json['role_permissions'] as Map<String, dynamic>? ?? const {};
    final limits = json['limits'] as Map<String, dynamic>? ?? const {};
    return DeviceMembers(
      device: SharedDeviceRef.fromJson(json['device'] as Map<String, dynamic>),
      members: (json['members'] as List? ?? const [])
          .map((item) => DeviceMember.fromJson(item as Map<String, dynamic>))
          .toList(),
      invites: (json['invites'] as List? ?? const [])
          .map((item) => SentInvite.fromJson(item as Map<String, dynamic>))
          .toList(),
      rolePermissions: {
        for (final entry in roles.entries) entry.key: _strings(entry.value),
      },
      maxMembers: (limits['max_members'] as num?)?.toInt() ?? 10,
      used: (limits['used'] as num?)?.toInt() ?? 0,
    );
  }
}
