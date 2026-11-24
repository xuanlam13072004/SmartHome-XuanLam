/// Automations ("Tự động"): Khi → Nếu → Thì, as the API Gateway returns them.
library;

Map<String, dynamic> _map(Object? value) =>
    value is Map ? Map<String, dynamic>.from(value) : <String, dynamic>{};

List<Map<String, dynamic>> _maps(Object? value) =>
    (value as List? ?? const []).map(_map).toList(growable: false);

DateTime? _time(Object? value) => value == null ? null : DateTime.parse(value as String).toLocal();

/// A device state an automation may watch (GET /automations/options).
class AutomationProperty {
  const AutomationProperty({
    required this.property,
    required this.instanceLabel,
    required this.label,
    required this.kind,
    required this.operators,
    this.enumValues = const [],
    this.unit,
    this.minimum,
    this.maximum,
  });

  /// Catalog path, e.g. `instances.door_position.reported.door_state`.
  final String property;
  final String instanceLabel;
  final String label;

  /// boolean · enum · number
  final String kind;

  /// eq · ne · gt · lt
  final List<String> operators;
  final List<String> enumValues;
  final String? unit;
  final num? minimum;
  final num? maximum;

  /// The last part of the path (`door_state`), used for value labels.
  String get name => property.split('.').last;

  factory AutomationProperty.fromJson(Map<String, dynamic> json) => AutomationProperty(
        property: json['property'] as String,
        instanceLabel: json['instance_label'] as String? ?? '',
        label: json['label'] as String? ?? json['property'] as String,
        kind: json['kind'] as String? ?? 'enum',
        operators: (json['operators'] as List? ?? const []).map((item) => '$item').toList(growable: false),
        enumValues: (json['enum'] as List? ?? const []).map((item) => '$item').toList(growable: false),
        unit: json['unit'] as String?,
        minimum: json['minimum'] as num?,
        maximum: json['maximum'] as num?,
      );
}

/// An event a device may report (GET /automations/options).
class AutomationEventOption {
  const AutomationEventOption({
    required this.event,
    required this.instanceLabel,
    required this.capabilityId,
    required this.eventName,
    required this.severity,
  });

  /// `<instance>.<event>`, e.g. `hazard.incident_started`.
  final String event;
  final String instanceLabel;
  final String capabilityId;
  final String eventName;
  final String severity;

  factory AutomationEventOption.fromJson(Map<String, dynamic> json) => AutomationEventOption(
        event: json['event'] as String,
        instanceLabel: json['instance_label'] as String? ?? '',
        capabilityId: json['capability_id'] as String? ?? '',
        eventName: json['event_name'] as String? ?? '',
        severity: json['severity'] as String? ?? 'info',
      );
}

class AutomationDevice {
  const AutomationDevice({
    required this.mac,
    required this.name,
    required this.triggers,
    required this.events,
    required this.conditions,
    this.roomId,
    this.isWeather = false,
  });

  final String mac;
  final String name;
  final String? roomId;
  final List<AutomationProperty> triggers;
  final List<AutomationEventOption> events;
  final List<AutomationProperty> conditions;

  /// The weather at the account's home: offered like a device, for "Nếu" only.
  final bool isWeather;

  /// The weather conditions of GET /automations/options (`weather.conditions`) as a device.
  factory AutomationDevice.weather(String place, List<AutomationProperty> conditions) => AutomationDevice(
        mac: '',
        name: 'Thời tiết ở $place',
        triggers: const [],
        events: const [],
        conditions: conditions,
        isWeather: true,
      );

  factory AutomationDevice.fromJson(Map<String, dynamic> json) => AutomationDevice(
        mac: json['mac'] as String,
        name: json['name'] as String? ?? '',
        roomId: json['room_id'] as String?,
        triggers: _maps(json['triggers']).map(AutomationProperty.fromJson).toList(growable: false),
        events: _maps(json['events']).map(AutomationEventOption.fromJson).toList(growable: false),
        conditions: _maps(json['conditions']).map(AutomationProperty.fromJson).toList(growable: false),
      );
}

/// "<device>: <state> <operator> <value>" — a state trigger or a condition.
class StateComparison {
  const StateComparison({
    required this.mac,
    required this.deviceName,
    required this.property,
    required this.label,
    required this.operator,
    required this.value,
    this.unit,
    this.available = true,
    this.weather,
  });

  final String mac;
  final String deviceName;
  final String property;
  final String label;
  final String operator;
  final Object value;
  final String? unit;

  /// False when the device left this account or the catalog no longer offers
  /// the state; for the weather, while the account has no home location.
  final bool available;

  /// A weather condition at home (`rain_next_12h`…) instead of a device state.
  final String? weather;

  String get name => property.split('.').last;

  bool get isWeather => weather != null;

  factory StateComparison.fromJson(Map<String, dynamic> json) {
    final device = _map(json['device']);
    final property = json['property'] as String;
    final weather = json['kind'] == 'weather';
    return StateComparison(
      mac: device['mac'] as String? ?? '',
      deviceName: weather ? 'Thời tiết' : device['name'] as String? ?? 'Thiết bị đã gỡ',
      property: property,
      label: json['label'] as String? ?? property,
      operator: json['operator'] as String? ?? 'eq',
      value: json['value'] as Object? ?? '',
      unit: json['unit'] as String?,
      available: json['available'] as bool? ?? true,
      weather: weather ? property.split('.').last : null,
    );
  }

  factory StateComparison.of(AutomationDevice device, AutomationProperty property, String operator, Object value) =>
      StateComparison(
        mac: device.mac,
        deviceName: device.isWeather ? 'Thời tiết' : device.name,
        property: property.property,
        label: property.label,
        operator: operator,
        value: value,
        unit: property.unit,
        weather: device.isWeather ? property.name : null,
      );

  Map<String, dynamic> toJson() => weather != null
      ? {'weather': weather, 'operator': operator, 'value': value}
      : {'mac': mac, 'property': property, 'operator': operator, 'value': value};
}

/// "Khi": a device state, a device event or a time on chosen weekdays.
class AutomationTrigger {
  const AutomationTrigger.state(StateComparison this.state)
      : kind = 'state',
        event = null,
        time = null,
        days = const [];

  const AutomationTrigger.event(AutomationTriggerEvent this.event)
      : kind = 'event',
        state = null,
        time = null,
        days = const [];

  const AutomationTrigger.time(String this.time, this.days)
      : kind = 'time',
        state = null,
        event = null;

  /// state · event · time
  final String kind;
  final StateComparison? state;
  final AutomationTriggerEvent? event;
  final String? time;
  final List<int> days;

  bool get available => state?.available ?? event?.available ?? true;

  factory AutomationTrigger.fromJson(Map<String, dynamic> json) => switch (json['kind']) {
        'state' => AutomationTrigger.state(StateComparison.fromJson(json)),
        'event' => AutomationTrigger.event(AutomationTriggerEvent.fromJson(json)),
        _ => AutomationTrigger.time(
            json['time'] as String? ?? '00:00',
            (json['days'] as List? ?? const []).map((day) => (day as num).toInt()).toList(growable: false),
          ),
      };

  Map<String, dynamic> toJson() => switch (kind) {
        'state' => {'kind': 'state', ...state!.toJson()},
        'event' => {'kind': 'event', 'mac': event!.mac, 'event': event!.event},
        _ => {'kind': 'time', 'time': time, 'days': days},
      };
}

class AutomationTriggerEvent {
  const AutomationTriggerEvent({
    required this.mac,
    required this.deviceName,
    required this.event,
    required this.eventName,
    required this.instanceLabel,
    this.available = true,
  });

  final String mac;
  final String deviceName;
  final String event;
  final String eventName;
  final String instanceLabel;
  final bool available;

  factory AutomationTriggerEvent.fromJson(Map<String, dynamic> json) {
    final device = _map(json['device']);
    return AutomationTriggerEvent(
      mac: device['mac'] as String? ?? '',
      deviceName: device['name'] as String? ?? 'Thiết bị đã gỡ',
      event: json['event'] as String,
      eventName: json['event_name'] as String? ?? '',
      instanceLabel: json['instance_label'] as String? ?? '',
      available: json['available'] as bool? ?? true,
    );
  }

  factory AutomationTriggerEvent.of(AutomationDevice device, AutomationEventOption option) => AutomationTriggerEvent(
        mac: device.mac,
        deviceName: device.name,
        event: option.event,
        eventName: option.eventName,
        instanceLabel: option.instanceLabel,
      );
}

class Automation {
  const Automation({
    required this.id,
    required this.name,
    required this.enabled,
    required this.trigger,
    required this.conditions,
    required this.timezone,
    required this.cooldownSeconds,
    this.windowFrom,
    this.windowTo,
    this.sceneId,
    this.sceneName,
    this.notifyMessage,
    this.suggestion,
    this.nextRunAt,
    this.lastTriggeredAt,
    this.lastResult,
    this.lastSkipReason,
    this.lastRunId,
  });

  final String id;
  final String name;
  final bool enabled;
  final AutomationTrigger trigger;
  final List<StateComparison> conditions;
  final String timezone;
  final int cooldownSeconds;

  /// Active window (HH:MM); `to` before `from` runs past midnight.
  final String? windowFrom;
  final String? windowTo;
  final String? sceneId;
  final String? sceneName;
  final String? notifyMessage;
  final String? suggestion;
  final DateTime? nextRunAt;
  final DateTime? lastTriggeredAt;

  /// started · notified · skipped_* · no_action · unavailable · missed
  final String? lastResult;

  /// Why the last time did nothing besides the devices: `weather_unavailable`.
  final String? lastSkipReason;
  final String? lastRunId;

  bool get hasUnavailableParts => !trigger.available || conditions.any((condition) => !condition.available);

  factory Automation.fromJson(Map<String, dynamic> json) {
    final window = json['window'] is Map ? _map(json['window']) : null;
    final scene = json['scene'] is Map ? _map(json['scene']) : null;
    return Automation(
      id: json['id'] as String,
      name: json['name'] as String,
      enabled: json['enabled'] as bool? ?? true,
      trigger: AutomationTrigger.fromJson(_map(json['trigger'])),
      conditions: _maps(json['conditions']).map(StateComparison.fromJson).toList(growable: false),
      timezone: json['timezone'] as String? ?? '',
      cooldownSeconds: (json['cooldown_seconds'] as num?)?.toInt() ?? 300,
      windowFrom: window?['from'] as String?,
      windowTo: window?['to'] as String?,
      sceneId: scene?['id'] as String?,
      sceneName: scene?['name'] as String?,
      notifyMessage: json['notify_message'] as String?,
      suggestion: json['suggestion'] as String?,
      nextRunAt: _time(json['next_run_at']),
      lastTriggeredAt: _time(json['last_triggered_at']),
      lastResult: json['last_result'] as String?,
      lastSkipReason: json['last_skip_reason'] as String?,
      lastRunId: json['last_run_id'] as String?,
    );
  }

  /// This automation after it fired (`automation_fired`).
  Automation withStatus(Map<String, dynamic> status) => Automation(
        id: id,
        name: name,
        enabled: enabled,
        trigger: trigger,
        conditions: conditions,
        timezone: timezone,
        cooldownSeconds: cooldownSeconds,
        windowFrom: windowFrom,
        windowTo: windowTo,
        sceneId: sceneId,
        sceneName: sceneName,
        notifyMessage: notifyMessage,
        suggestion: suggestion,
        nextRunAt: status.containsKey('next_run_at') ? _time(status['next_run_at']) : nextRunAt,
        lastTriggeredAt: _time(status['last_triggered_at']) ?? lastTriggeredAt,
        lastResult: status['last_result'] as String? ?? lastResult,
        lastSkipReason: status.containsKey('last_result') ? status['last_skip_reason'] as String? : lastSkipReason,
        lastRunId: status['last_run_id'] as String? ?? lastRunId,
      );
}

/// What the editor saves (POST /automations, PUT /automations/:id).
class AutomationDraft {
  const AutomationDraft({
    required this.name,
    required this.enabled,
    required this.trigger,
    required this.conditions,
    required this.timezone,
    required this.cooldownSeconds,
    this.windowFrom,
    this.windowTo,
    this.sceneId,
    this.notifyMessage,
  });

  final String name;
  final bool enabled;
  final AutomationTrigger trigger;
  final List<StateComparison> conditions;
  final String timezone;
  final int cooldownSeconds;
  final String? windowFrom;
  final String? windowTo;
  final String? sceneId;
  final String? notifyMessage;

  Map<String, dynamic> toJson() => {
        'name': name,
        'enabled': enabled,
        'timezone': timezone,
        'trigger': trigger.toJson(),
        'conditions': conditions.map((condition) => condition.toJson()).toList(),
        'window': windowFrom != null && windowTo != null ? {'from': windowFrom, 'to': windowTo} : null,
        'scene_id': sceneId,
        'notify_message': notifyMessage,
        'cooldown_seconds': cooldownSeconds,
      };
}

class AutomationList {
  const AutomationList({required this.automations, required this.maxAutomations, required this.maxConditions});

  final List<Automation> automations;
  final int maxAutomations;
  final int maxConditions;

  bool get isFull => automations.length >= maxAutomations;

  Automation? byId(String? id) {
    for (final automation in automations) {
      if (automation.id == id) return automation;
    }
    return null;
  }

  AutomationList withAutomations(List<Automation> value) =>
      AutomationList(automations: value, maxAutomations: maxAutomations, maxConditions: maxConditions);

  factory AutomationList.fromJson(Map<String, dynamic> json) {
    final limits = _map(json['limits']);
    return AutomationList(
      automations: _maps(json['automations']).map(Automation.fromJson).toList(growable: false),
      maxAutomations: (limits['max_automations'] as num?)?.toInt() ?? 30,
      maxConditions: (limits['max_conditions'] as num?)?.toInt() ?? 3,
    );
  }
}

/// "Gợi ý": a ready-made automation for devices the account has.
class AutomationSuggestion {
  const AutomationSuggestion({
    required this.key,
    required this.template,
    required this.title,
    required this.description,
  });

  final String key;

  /// gas_vent · night_lock · night_door · rain_stop · offline · weather_water · weather_roof
  final String template;
  final String title;
  final String description;

  factory AutomationSuggestion.fromJson(Map<String, dynamic> json) => AutomationSuggestion(
        key: json['key'] as String,
        template: json['template'] as String? ?? '',
        title: json['title'] as String? ?? '',
        description: json['description'] as String? ?? '',
      );
}
