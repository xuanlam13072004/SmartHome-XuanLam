/// One operation a scene step may use on a device (from GET /scenes/actions).
class SceneAction {
  const SceneAction({
    required this.instanceId,
    required this.instanceLabel,
    required this.operation,
    required this.label,
    required this.protected,
    required this.input,
  });

  final String instanceId;
  final String instanceLabel;
  final String operation;
  final String label;

  /// Confirmed (or password-checked) in the app; a scene with one needs the password to run.
  final bool protected;

  /// Input schema: field name → {type, enum, minimum, maximum, unit, …}.
  final Map<String, dynamic> input;

  factory SceneAction.fromJson(Map<String, dynamic> json) => SceneAction(
        instanceId: json['instance_id'] as String,
        instanceLabel: json['instance_label'] as String? ?? '',
        operation: json['operation'] as String,
        label: json['label'] as String? ?? json['operation'] as String,
        protected: json['protected'] as bool? ?? false,
        input: Map<String, dynamic>.from(json['input'] as Map? ?? const {}),
      );
}

class SceneActionDevice {
  const SceneActionDevice({
    required this.mac,
    required this.name,
    required this.productId,
    required this.actions,
    this.roomId,
  });

  final String mac;
  final String name;
  final String productId;
  final String? roomId;
  final List<SceneAction> actions;

  factory SceneActionDevice.fromJson(Map<String, dynamic> json) => SceneActionDevice(
        mac: json['mac'] as String,
        name: json['name'] as String,
        productId: json['product_id'] as String? ?? '',
        roomId: json['room_id'] as String?,
        actions: (json['actions'] as List? ?? const [])
            .map((item) => SceneAction.fromJson(Map<String, dynamic>.from(item as Map)))
            .toList(growable: false),
      );
}

class SceneStep {
  const SceneStep({
    required this.mac,
    required this.deviceName,
    required this.instanceId,
    required this.instanceLabel,
    required this.operation,
    required this.label,
    required this.input,
    required this.delaySeconds,
    required this.protected,
    this.available = true,
  });

  final String mac;
  final String deviceName;
  final String instanceId;
  final String instanceLabel;
  final String operation;
  final String label;
  final Map<String, dynamic> input;

  /// Wait before this step; the first step starts right away.
  final int delaySeconds;
  final bool protected;

  /// False when the device left this account or the action is no longer allowed.
  final bool available;

  factory SceneStep.fromJson(Map<String, dynamic> json) {
    final device = Map<String, dynamic>.from(json['device'] as Map? ?? const {});
    return SceneStep(
      mac: device['mac'] as String? ?? '',
      deviceName: device['name'] as String? ?? '',
      instanceId: json['instance_id'] as String,
      instanceLabel: json['instance_label'] as String? ?? '',
      operation: json['operation'] as String,
      label: json['label'] as String? ?? json['operation'] as String,
      input: Map<String, dynamic>.from(json['input'] as Map? ?? const {}),
      delaySeconds: (json['delay_seconds'] as num?)?.toInt() ?? 0,
      protected: json['protected'] as bool? ?? false,
      available: json['available'] as bool? ?? true,
    );
  }

  factory SceneStep.fromAction(SceneActionDevice device, SceneAction action, Map<String, dynamic> input) =>
      SceneStep(
        mac: device.mac,
        deviceName: device.name,
        instanceId: action.instanceId,
        instanceLabel: action.instanceLabel,
        operation: action.operation,
        label: action.label,
        input: input,
        delaySeconds: 0,
        protected: action.protected,
      );

  SceneStep copyWith({int? delaySeconds, Map<String, dynamic>? input}) => SceneStep(
        mac: mac,
        deviceName: deviceName,
        instanceId: instanceId,
        instanceLabel: instanceLabel,
        operation: operation,
        label: label,
        input: input ?? this.input,
        delaySeconds: delaySeconds ?? this.delaySeconds,
        protected: protected,
        available: available,
      );

  Map<String, dynamic> toJson() => {
        'mac': mac,
        'instance_id': instanceId,
        'operation': operation,
        'input': input,
        'delay_seconds': delaySeconds,
      };
}

class SceneRunStep {
  const SceneRunStep({
    required this.index,
    required this.deviceName,
    required this.label,
    required this.input,
    required this.delaySeconds,
    required this.status,
    this.deviceMac,
    this.reasonCode,
  });

  final int index;
  final String deviceName;
  final String? deviceMac;
  final String label;
  final Map<String, dynamic> input;
  final int delaySeconds;

  /// pending · dispatched · succeeded · failed
  final String status;
  final String? reasonCode;

  factory SceneRunStep.fromJson(Map<String, dynamic> json) => SceneRunStep(
        index: (json['index'] as num?)?.toInt() ?? 0,
        deviceName: json['device_name'] as String? ?? '',
        deviceMac: json['device_mac'] as String?,
        label: json['label'] as String? ?? '',
        input: Map<String, dynamic>.from(json['input'] as Map? ?? const {}),
        delaySeconds: (json['delay_seconds'] as num?)?.toInt() ?? 0,
        status: json['status'] as String? ?? 'pending',
        reasonCode: json['reason_code'] as String?,
      );
}

class SceneRun {
  const SceneRun({
    required this.id,
    required this.sceneName,
    required this.trigger,
    required this.status,
    required this.startedAt,
    required this.steps,
    this.sceneId,
    this.finishedAt,
    this.automationName,
  });

  final String id;
  final String? sceneId;
  final String sceneName;

  /// manual · schedule · automation
  final String trigger;

  /// The automation that started it, while it exists.
  final String? automationName;

  /// running · succeeded · partial · failed
  final String status;
  final DateTime startedAt;
  final DateTime? finishedAt;
  final List<SceneRunStep> steps;

  bool get running => status == 'running';

  factory SceneRun.fromJson(Map<String, dynamic> json) => SceneRun(
        id: json['id'] as String,
        sceneId: json['scene_id'] as String?,
        sceneName: json['scene_name'] as String? ?? '',
        trigger: json['trigger'] as String? ?? 'manual',
        automationName: json['automation'] is Map ? (json['automation'] as Map)['name'] as String? : null,
        status: json['status'] as String? ?? 'running',
        startedAt: DateTime.parse(json['started_at'] as String).toLocal(),
        finishedAt: json['finished_at'] == null ? null : DateTime.parse(json['finished_at'] as String).toLocal(),
        steps: (json['steps'] as List? ?? const [])
            .map((item) => SceneRunStep.fromJson(Map<String, dynamic>.from(item as Map)))
            .toList(growable: false),
      );
}

/// "Hẹn giờ": run a scene at [time] (HH:MM, local) on [days] (1 = Monday … 7 = Sunday).
class SceneSchedule {
  const SceneSchedule({
    required this.id,
    required this.sceneId,
    required this.time,
    required this.days,
    required this.timezone,
    required this.enabled,
    this.nextRunAt,
    this.lastFiredAt,
    this.lastResult,
  });

  final String id;
  final String sceneId;
  final String time;
  final List<int> days;
  final String timezone;
  final bool enabled;
  final DateTime? nextRunAt;
  final DateTime? lastFiredAt;

  /// started · skipped_running · skipped_protected · skipped_empty · missed
  final String? lastResult;

  static DateTime? _time(Object? value) => value == null ? null : DateTime.parse(value as String).toLocal();

  factory SceneSchedule.fromJson(Map<String, dynamic> json) => SceneSchedule(
        id: json['id'] as String,
        sceneId: json['scene_id'] as String,
        time: json['time'] as String,
        days: (json['days'] as List? ?? const []).map((day) => (day as num).toInt()).toList(growable: false),
        timezone: json['timezone'] as String? ?? '',
        enabled: json['enabled'] as bool? ?? false,
        nextRunAt: _time(json['next_run_at']),
        lastFiredAt: _time(json['last_fired_at']),
        lastResult: json['last_result'] as String?,
      );
}

class Scene {
  const Scene({
    required this.id,
    required this.name,
    required this.icon,
    required this.position,
    required this.steps,
    required this.protected,
    this.lastRunId,
    this.lastRunStatus,
    this.lastRunAt,
    this.schedules = const [],
  });

  final String id;
  final String name;
  final String icon;
  final int position;
  final List<SceneStep> steps;
  final bool protected;
  final String? lastRunId;
  final String? lastRunStatus;
  final DateTime? lastRunAt;
  final List<SceneSchedule> schedules;

  /// The earliest upcoming scheduled run, if any schedule is on.
  DateTime? get nextScheduledRun {
    DateTime? next;
    for (final schedule in schedules) {
      final at = schedule.nextRunAt;
      if (schedule.enabled && at != null && (next == null || at.isBefore(next))) next = at;
    }
    return next;
  }

  bool get hasUnavailableSteps => steps.any((step) => !step.available);

  factory Scene.fromJson(Map<String, dynamic> json) {
    final last = json['last_run'] is Map ? Map<String, dynamic>.from(json['last_run'] as Map) : null;
    return Scene(
      id: json['id'] as String,
      name: json['name'] as String,
      icon: json['icon'] as String? ?? 'play',
      position: (json['position'] as num?)?.toInt() ?? 0,
      steps: (json['steps'] as List? ?? const [])
          .map((item) => SceneStep.fromJson(Map<String, dynamic>.from(item as Map)))
          .toList(growable: false),
      protected: json['protected'] as bool? ?? false,
      lastRunId: last?['id'] as String?,
      lastRunStatus: last?['status'] as String?,
      lastRunAt: last?['started_at'] == null ? null : DateTime.parse(last!['started_at'] as String).toLocal(),
      schedules: (json['schedules'] as List? ?? const [])
          .map((item) => SceneSchedule.fromJson(Map<String, dynamic>.from(item as Map)))
          .toList(growable: false),
    );
  }

  /// This scene with [run] as its latest run.
  Scene withRun(SceneRun run) => Scene(
        id: id,
        name: name,
        icon: icon,
        position: position,
        steps: steps,
        protected: protected,
        lastRunId: run.id,
        lastRunStatus: run.status,
        lastRunAt: run.startedAt,
        schedules: schedules,
      );

  Scene withSchedules(List<SceneSchedule> value) => Scene(
        id: id,
        name: name,
        icon: icon,
        position: position,
        steps: steps,
        protected: protected,
        lastRunId: lastRunId,
        lastRunStatus: lastRunStatus,
        lastRunAt: lastRunAt,
        schedules: value,
      );

  Scene withPosition(int value) => Scene(
        id: id,
        name: name,
        icon: icon,
        position: value,
        steps: steps,
        protected: protected,
        lastRunId: lastRunId,
        lastRunStatus: lastRunStatus,
        lastRunAt: lastRunAt,
        schedules: schedules,
      );
}

class SceneList {
  const SceneList({
    required this.scenes,
    required this.maxScenes,
    required this.maxSteps,
    this.maxSchedules = 5,
  });

  final List<Scene> scenes;
  final int maxScenes;
  final int maxSteps;
  final int maxSchedules;

  bool get isFull => scenes.length >= maxScenes;

  Scene? byId(String? id) {
    for (final scene in scenes) {
      if (scene.id == id) return scene;
    }
    return null;
  }

  SceneList withScenes(List<Scene> scenes) =>
      SceneList(scenes: scenes, maxScenes: maxScenes, maxSteps: maxSteps, maxSchedules: maxSchedules);

  factory SceneList.fromJson(Map<String, dynamic> json) {
    final limits = Map<String, dynamic>.from(json['limits'] as Map? ?? const {});
    return SceneList(
      scenes: (json['scenes'] as List? ?? const [])
          .map((item) => Scene.fromJson(Map<String, dynamic>.from(item as Map)))
          .toList(growable: false),
      maxScenes: (limits['max_scenes'] as num?)?.toInt() ?? 50,
      maxSteps: (limits['max_steps'] as num?)?.toInt() ?? 10,
      maxSchedules: (limits['max_schedules'] as num?)?.toInt() ?? 5,
    );
  }
}
