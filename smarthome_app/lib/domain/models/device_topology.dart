enum DeviceTopologyRole {
  hub,
  node,
  unknown;

  static DeviceTopologyRole fromWire(String? value) {
    return switch (value?.toLowerCase()) {
      'hub' => DeviceTopologyRole.hub,
      'node' => DeviceTopologyRole.node,
      _ => DeviceTopologyRole.unknown,
    };
  }
}

enum DeviceTopologyState {
  stable,
  degradedDirect,
  electing,
  empty,
  unknown;

  static DeviceTopologyState fromWire(String? value) {
    return switch (value?.toLowerCase()) {
      'stable' => DeviceTopologyState.stable,
      'degraded_direct' => DeviceTopologyState.degradedDirect,
      'electing' => DeviceTopologyState.electing,
      'empty' => DeviceTopologyState.empty,
      _ => DeviceTopologyState.unknown,
    };
  }
}

enum DeviceTransportMode {
  hub,
  relay,
  directFallback,
  offline,
  unknown;

  static DeviceTransportMode fromWire(String? value) {
    return switch (value?.toLowerCase()) {
      'hub' => DeviceTransportMode.hub,
      'relay' => DeviceTransportMode.relay,
      'direct_fallback' => DeviceTransportMode.directFallback,
      'offline' => DeviceTransportMode.offline,
      _ => DeviceTransportMode.unknown,
    };
  }
}

class DeviceTopology {
  const DeviceTopology({
    required this.networkId,
    required this.role,
    required this.epoch,
    required this.state,
    required this.transportMode,
    this.joinRank,
    this.activeHubMac,
    this.lastTransportChange,
  });

  final String networkId;
  final DeviceTopologyRole role;
  final int epoch;
  final DeviceTopologyState state;
  final DeviceTransportMode transportMode;
  final int? joinRank;
  final String? activeHubMac;
  final String? lastTransportChange;

  bool get isHub => role == DeviceTopologyRole.hub;
  bool get isNode => role == DeviceTopologyRole.node;
  bool get usesDirectFallback =>
      transportMode == DeviceTransportMode.directFallback;
  bool get isOptimizing =>
      state == DeviceTopologyState.electing ||
      state == DeviceTopologyState.degradedDirect;

  String get roleLabel => switch (role) {
        DeviceTopologyRole.hub => 'Hub chính',
        DeviceTopologyRole.node => 'Thiết bị Node',
        DeviceTopologyRole.unknown => 'Chưa xác định',
      };

  String get connectionLabel => switch (transportMode) {
        DeviceTransportMode.hub => 'Hub',
        DeviceTransportMode.relay => 'Qua Hub',
        DeviceTransportMode.directFallback => 'Kết nối trực tiếp',
        DeviceTransportMode.offline => 'Ngoại tuyến',
        DeviceTransportMode.unknown => 'Đang xác định',
      };

  String get stateLabel => switch (state) {
        DeviceTopologyState.stable => 'Kết nối ổn định',
        DeviceTopologyState.degradedDirect ||
        DeviceTopologyState.electing =>
          'Đang tối ưu kết nối',
        DeviceTopologyState.empty => 'Mạng không còn thiết bị',
        DeviceTopologyState.unknown => 'Đang đồng bộ',
      };

  DeviceTopology copyWith({
    String? networkId,
    DeviceTopologyRole? role,
    int? epoch,
    DeviceTopologyState? state,
    DeviceTransportMode? transportMode,
    int? joinRank,
    String? activeHubMac,
    bool clearActiveHub = false,
    String? lastTransportChange,
  }) {
    return DeviceTopology(
      networkId: networkId ?? this.networkId,
      role: role ?? this.role,
      epoch: epoch ?? this.epoch,
      state: state ?? this.state,
      transportMode: transportMode ?? this.transportMode,
      joinRank: joinRank ?? this.joinRank,
      activeHubMac: clearActiveHub ? null : activeHubMac ?? this.activeHubMac,
      lastTransportChange: lastTransportChange ?? this.lastTransportChange,
    );
  }
}
