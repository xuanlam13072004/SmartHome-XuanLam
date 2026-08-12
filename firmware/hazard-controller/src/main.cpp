#include <Arduino.h>
#include <ArduinoJson.h>
#include <DHT.h>
#include <Preferences.h>
#include <PubSubClient.h>
#include <WiFi.h>
#include <algorithm>
#include <cmath>
#include <ctime>

#include "board_config.h"
#include "hazard_state_machine.h"

namespace {

constexpr char TOPOLOGY_SCHEMA[] = "device.topology.assignment.v2";
constexpr char OPERATION_SCHEMA[] = "device.operation.v2";
constexpr std::uint32_t VALID_EPOCH_FLOOR = 1'700'000'000UL;

struct SensorSnapshot {
    float temperature = NAN;
    float humidity = NAN;
    float gasLevel = 0;
    float smokeLevel = 0;
    bool flameDetected = false;
    bool mq2Ready = false;
    bool dhtHealthy = false;
};

struct TopologyAssignment {
    bool valid = false;
    String networkId;
    std::uint32_t epoch = 0;
    String state;
    String role;
    String transportMode;
    String activeHubMac;
};

enum class IncidentState : std::uint8_t {
    Idle = 0,
    Active = 1,
    Acknowledged = 2,
};

struct OperationReceipt {
    String id;
    String status;
    String reason;
};

WiFiClient wifiClient;
PubSubClient mqtt(wifiClient);
DHT dht(BoardConfig::DHT_PIN, DHT11);
Preferences preferences;
HazardSirenController siren;
SensorSnapshot sensors;
TopologyAssignment topology;

String deviceMac;
String directControlTopic;
String hubControlTopic;
String topologyTopic;
String telemetryTopic;
String ackTopic;
String statusTopic;

IncidentState incidentState = IncidentState::Idle;
String activeIncidentId;
OperationReceipt receipts[8];
std::size_t nextReceipt = 0;

std::uint32_t bootId = 0;
std::uint32_t sequence = 0;
std::uint32_t stateVersion = 0;
std::uint64_t lastSensorAt = 0;
std::uint64_t lastTelemetryAt = 0;
std::uint64_t lastPresenceAt = 0;
std::uint64_t lastReconnectAt = 0;
std::uint64_t lastWifiAttemptAt = 0;
bool wifiBeginIssued = false;
bool telemetryRequested = true;
std::uint64_t pendingMuteUntilEpoch = 0;
bool muteRestorePending = false;

bool rawButtonPressed = false;
bool stableButtonPressed = false;
std::uint64_t buttonChangedAt = 0;
bool rawFlameDetected = false;
bool stableFlameDetected = false;
std::uint64_t flameChangedAt = 0;

std::uint64_t nowMillis() {
    return static_cast<std::uint64_t>(millis());
}

std::uint64_t nowEpochSeconds() {
    const auto value = static_cast<std::uint64_t>(time(nullptr));
    return value >= VALID_EPOCH_FLOOR ? value : 0;
}

String isoTimestamp(std::uint64_t epochSeconds = 0) {
    const auto effective = epochSeconds == 0 ? nowEpochSeconds() : epochSeconds;
    const std::time_t raw = static_cast<std::time_t>(effective);
    std::tm utc{};
    gmtime_r(&raw, &utc);
    char buffer[25]{};
    strftime(buffer, sizeof(buffer), "%Y-%m-%dT%H:%M:%SZ", &utc);
    return String(buffer);
}

const char* incidentStateName() {
    switch (incidentState) {
        case IncidentState::Idle: return "idle";
        case IncidentState::Active: return "active";
        case IncidentState::Acknowledged: return "acknowledged";
    }
    return "idle";
}

void writeBuzzer() {
    const bool sounding = siren.snapshot().audible == AudibleState::Sounding;
    const auto level = sounding
        ? BoardConfig::BUZZER_ACTIVE_LEVEL
        : static_cast<std::uint8_t>(!BoardConfig::BUZZER_ACTIVE_LEVEL);
    digitalWrite(BoardConfig::BUZZER_PIN, level);
}

void persistSafetyState() {
    preferences.putULong64(
        "muteUntil",
        muteRestorePending ? pendingMuteUntilEpoch : siren.snapshot().muteUntilEpochSeconds
    );
    preferences.putUChar("incState", static_cast<std::uint8_t>(incidentState));
    preferences.putString("incidentId", activeIncidentId);
}

void markStateChanged() {
    ++stateVersion;
    telemetryRequested = true;
}

bool activeHazard(RiskLevel risk) {
    return risk == RiskLevel::Alarm || risk == RiskLevel::Emergency;
}

RiskLevel calculateRisk() {
    if (sensors.flameDetected) return RiskLevel::Emergency;
    if (
        sensors.gasLevel >= BoardConfig::GAS_ALARM_THRESHOLD
        || sensors.smokeLevel >= BoardConfig::SMOKE_ALARM_THRESHOLD
    ) {
        return RiskLevel::Alarm;
    }
    if (!sensors.mq2Ready || !sensors.dhtHealthy) return RiskLevel::SensorFault;
    if (
        sensors.gasLevel >= BoardConfig::GAS_WARNING_THRESHOLD
        || sensors.smokeLevel >= BoardConfig::SMOKE_WARNING_THRESHOLD
    ) {
        return RiskLevel::Warning;
    }
    return RiskLevel::Normal;
}

void updateIncident(RiskLevel risk) {
    if (!activeHazard(risk) || incidentState != IncidentState::Idle) return;
    incidentState = IncidentState::Active;
    activeIncidentId = deviceMac + "-" + String(bootId) + "-" + String(millis());
    persistSafetyState();
    markStateChanged();
}

void updateSensors() {
    const auto currentMillis = nowMillis();
    const auto mq2Raw = analogRead(BoardConfig::MQ2_ANALOG_PIN);
    const auto normalized = std::clamp(
        static_cast<float>(mq2Raw) * 100.0F / 4095.0F,
        0.0F,
        100.0F
    );

    // MQ2 exposes one analog channel. Until calibration/model selection is
    // finalized, gas and smoke deliberately share that normalized signal.
    sensors.gasLevel = normalized;
    sensors.smokeLevel = normalized;
    sensors.mq2Ready = currentMillis >= BoardConfig::MQ2_WARMUP_MS;

    const float humidity = dht.readHumidity();
    const float temperature = dht.readTemperature();
    sensors.dhtHealthy = !std::isnan(humidity) && !std::isnan(temperature);
    if (sensors.dhtHealthy) {
        sensors.humidity = humidity;
        sensors.temperature = temperature;
    }

    const bool nextRawFlame = digitalRead(BoardConfig::FLAME_DIGITAL_PIN)
        == BoardConfig::FLAME_ACTIVE_LEVEL;
    if (nextRawFlame != rawFlameDetected) {
        rawFlameDetected = nextRawFlame;
        flameChangedAt = currentMillis;
    }
    if (
        rawFlameDetected != stableFlameDetected
        && currentMillis - flameChangedAt >= BoardConfig::FLAME_DEBOUNCE_MS
    ) {
        stableFlameDetected = rawFlameDetected;
    }
    sensors.flameDetected = stableFlameDetected;

    const auto previousRisk = siren.snapshot().risk;
    const auto previousAudible = siren.snapshot().audible;
    const auto risk = calculateRisk();
    siren.setRisk(risk, nowEpochSeconds(), currentMillis);
    updateIncident(risk);
    if (previousRisk != risk || previousAudible != siren.snapshot().audible) {
        markStateChanged();
    } else {
        // Sensor measurements are sampled data even if the risk band is stable.
        ++stateVersion;
    }
}

bool hasTransport() {
    return topology.valid
        && (topology.transportMode == "hub" || topology.transportMode == "direct_fallback");
}

void appendTransport(JsonObject target, const TopologyAssignment& assignment) {
    target["mode"] = assignment.transportMode;
    target["network_id"] = assignment.networkId;
    target["topology_epoch"] = assignment.epoch;
    if (!assignment.activeHubMac.isEmpty()) target["hub_mac"] = assignment.activeHubMac;
}

bool publishDocument(const String& topic, JsonDocument& document, bool retain = false) {
    if (!mqtt.connected()) return false;
    String payload;
    serializeJson(document, payload);
    return mqtt.publish(topic.c_str(), payload.c_str(), retain);
}

void publishTopologyAck() {
    if (
        !topology.valid
        || topology.role != "hub"
        || topology.state != "electing"
    ) {
        return;
    }
    JsonDocument document;
    document["schema"] = "device.topology.ack.v2";
    document["device_id"] = deviceMac;
    document["network_id"] = topology.networkId;
    document["topology_epoch"] = topology.epoch;
    document["status"] = "ready";
    document["observed_at"] = isoTimestamp();
    publishDocument("smarthome/" + deviceMac + "/topology/ack", document);
}

void publishPresence(const char* status) {
    if (!hasTransport()) return;
    JsonDocument document;
    document["schema"] = "device.presence.v2";
    document["device_id"] = deviceMac;
    document["product_id"] = BoardConfig::PRODUCT_ID;
    document["catalog_revision"] = BoardConfig::CATALOG_REVISION;
    document["status"] = status;
    document["observed_at"] = isoTimestamp();
    appendTransport(document["transport"].to<JsonObject>(), topology);
    if (publishDocument(statusTopic, document)) lastPresenceAt = nowMillis();
}

void publishTelemetry() {
    if (!hasTransport()) return;

    JsonDocument document;
    ++sequence;
    document["schema"] = "device.telemetry.v2";
    document["event_id"] = deviceMac + ":" + String(bootId) + ":" + String(sequence);
    document["device_id"] = deviceMac;
    document["product_id"] = BoardConfig::PRODUCT_ID;
    document["catalog_revision"] = BoardConfig::CATALOG_REVISION;
    document["state_version"] = stateVersion;
    document["seq"] = sequence;
    document["observed_at"] = isoTimestamp();

    JsonObject instances = document["instances"].to<JsonObject>();
    JsonObject gas = instances["kitchen_gas"]["reported"].to<JsonObject>();
    gas["gas_level"] = sensors.gasLevel;
    gas["calibration_state"] = sensors.mq2Ready ? "ready" : "warming_up";

    JsonObject smoke = instances["kitchen_smoke"]["reported"].to<JsonObject>();
    smoke["smoke_level"] = sensors.smokeLevel;
    smoke["calibration_state"] = sensors.mq2Ready ? "ready" : "warming_up";

    instances["kitchen_flame"]["reported"]["flame_detected"] = sensors.flameDetected;
    if (sensors.dhtHealthy) {
        instances["kitchen_temperature"]["reported"]["temperature"] = sensors.temperature;
        instances["kitchen_humidity"]["reported"]["humidity"] = sensors.humidity;
    } else {
        instances["kitchen_temperature"]["reported"]["temperature"] = nullptr;
        instances["kitchen_humidity"]["reported"]["humidity"] = nullptr;
    }

    JsonObject hazard = instances["hazard"]["reported"].to<JsonObject>();
    hazard["risk_level"] = HazardSirenController::riskName(siren.snapshot().risk);
    hazard["incident_state"] = incidentStateName();
    if (activeIncidentId.isEmpty()) hazard["active_incident_id"] = nullptr;
    else hazard["active_incident_id"] = activeIncidentId;

    JsonObject alarm = instances["alarm_siren"]["reported"].to<JsonObject>();
    alarm["audible_state"] = HazardSirenController::audibleName(siren.snapshot().audible);
    if (siren.snapshot().muteUntilEpochSeconds == 0) alarm["mute_until"] = nullptr;
    else alarm["mute_until"] = isoTimestamp(siren.snapshot().muteUntilEpochSeconds);

    JsonObject diagnostics = document["diagnostics"]["system"].to<JsonObject>();
    diagnostics["online"] = mqtt.connected();
    diagnostics["wifi_rssi"] = WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0;
    diagnostics["uptime"] = millis() / 1000UL;
    diagnostics["firmware_version"] = BoardConfig::FIRMWARE_VERSION;
    diagnostics["firmware_status"] = "healthy";
    appendTransport(document["transport"].to<JsonObject>(), topology);

    if (publishDocument(telemetryTopic, document)) {
        telemetryRequested = false;
        lastTelemetryAt = nowMillis();
    }
}

OperationReceipt* findReceipt(const String& operationId) {
    for (auto& receipt : receipts) {
        if (receipt.id == operationId) return &receipt;
    }
    return nullptr;
}

void rememberReceipt(const String& id, const char* status, const char* reason = "") {
    receipts[nextReceipt] = {id, status, reason};
    nextReceipt = (nextReceipt + 1) % 8;
}

void publishOperationAck(
    const String& operationId,
    const String& targetDeviceId,
    const char* status,
    const char* reason,
    JsonObjectConst route
) {
    JsonDocument document;
    document["schema"] = "device.operation.ack.v2";
    document["operation_id"] = operationId;
    document["device_id"] = targetDeviceId;
    document["status"] = status;
    document["observed_at"] = isoTimestamp();
    if (reason != nullptr && reason[0] != '\0') {
        document["reason_code"] = reason;
    }
    JsonObject transport = document["transport"].to<JsonObject>();
    transport["mode"] = route["mode"];
    transport["network_id"] = route["network_id"];
    transport["topology_epoch"] = route["topology_epoch"];
    if (!route["hub_mac"].isNull()) transport["hub_mac"] = route["hub_mac"];
    publishDocument(ackTopic, document);
}

const char* commandReason(SirenCommandResult result) {
    switch (result) {
        case SirenCommandResult::Applied: return "";
        case SirenCommandResult::InvalidDuration: return "INVALID_DURATION";
        case SirenCommandResult::ActiveHazard: return "ACTIVE_HAZARD";
        case SirenCommandResult::NotSounding: return "SIREN_NOT_SOUNDING";
    }
    return "DEVICE_OPERATION_REJECTED";
}

bool routeMatches(JsonObjectConst route, bool relayedTarget) {
    if (!topology.valid) return false;
    if (String(route["network_id"] | "") != topology.networkId) return false;
    if (route["topology_epoch"].as<std::uint32_t>() != topology.epoch) return false;
    const String mode = route["mode"] | "";
    if (relayedTarget) return topology.role == "hub" && mode == "relay";
    return mode == topology.transportMode;
}

SirenCommandResult applySirenOperation(const String& name, JsonObjectConst input) {
    const auto duration = input["duration_seconds"].as<std::uint16_t>();
    if (name == "test_siren") return siren.startTest(duration, nowMillis());
    if (name == "mute_siren") {
        return siren.mute(duration, nowEpochSeconds(), nowMillis());
    }
    return SirenCommandResult::InvalidDuration;
}

bool applyIncidentOperation(
    const String& name,
    JsonObjectConst input,
    const char*& reason
) {
    const String incidentId = input["incident_id"] | "";
    if (incidentState == IncidentState::Idle || incidentId != activeIncidentId) {
        reason = "INCIDENT_ID_MISMATCH";
        return false;
    }
    if (name == "acknowledge_incident") {
        incidentState = IncidentState::Acknowledged;
        persistSafetyState();
        markStateChanged();
        return true;
    }
    if (name == "reset_incident") {
        if (activeHazard(siren.snapshot().risk)) {
            reason = "HAZARD_NOT_CLEARED";
            return false;
        }
        incidentState = IncidentState::Idle;
        activeIncidentId = "";
        persistSafetyState();
        markStateChanged();
        return true;
    }
    reason = "UNSUPPORTED_OPERATION";
    return false;
}

void handleOperation(JsonDocument& document, bool receivedOnHubTopic) {
    if (String(document["schema"] | "") != OPERATION_SCHEMA) return;
    const String operationId = document["operation_id"] | "";
    const String targetDeviceId = document["target_device_id"] | "";
    JsonObjectConst route = document["route"].as<JsonObjectConst>();
    if (operationId.isEmpty() || targetDeviceId.isEmpty() || route.isNull()) return;

    if (auto* receipt = findReceipt(operationId)) {
        publishOperationAck(
            operationId,
            targetDeviceId,
            receipt->status.c_str(),
            receipt->reason.c_str(),
            route
        );
        return;
    }

    const bool relayedTarget = targetDeviceId != deviceMac;
    const bool identityMatches = String(document["product_id"] | "") == BoardConfig::PRODUCT_ID
        && document["catalog_revision"].as<std::uint16_t>() == BoardConfig::CATALOG_REVISION;
    if (!identityMatches || !routeMatches(route, relayedTarget)) {
        rememberReceipt(operationId, "rejected", "CONTRACT_OR_ROUTE_MISMATCH");
        publishOperationAck(
            operationId,
            targetDeviceId,
            "rejected",
            "CONTRACT_OR_ROUTE_MISMATCH",
            route
        );
        return;
    }

    if (relayedTarget) {
        // The backend contract is supported, but the physical Node radio is not
        // guessed here. A Hub must never pretend a command reached a Node.
        const char* reason = receivedOnHubTopic
            ? "EMBEDDED_RELAY_TRANSPORT_UNCONFIGURED"
            : "INVALID_OPERATION_TARGET";
        rememberReceipt(operationId, "rejected", reason);
        publishOperationAck(operationId, targetDeviceId, "rejected", reason, route);
        return;
    }

    const String instance = document["instance_id"] | "";
    const String name = document["operation_name"] | "";
    JsonObjectConst input = document["input"].as<JsonObjectConst>();
    bool applied = false;
    const char* reason = "UNSUPPORTED_OPERATION";

    if (instance == "alarm_siren") {
        const auto result = applySirenOperation(name, input);
        applied = result == SirenCommandResult::Applied;
        reason = commandReason(result);
    } else if (instance == "hazard") {
        applied = applyIncidentOperation(name, input, reason);
    }

    if (applied) {
        if (instance == "alarm_siren") {
            pendingMuteUntilEpoch = 0;
            muteRestorePending = false;
        }
        persistSafetyState();
        writeBuzzer();
        markStateChanged();
        rememberReceipt(operationId, "succeeded");
        publishOperationAck(operationId, targetDeviceId, "succeeded", "", route);
    } else {
        rememberReceipt(operationId, "rejected", reason);
        publishOperationAck(operationId, targetDeviceId, "rejected", reason, route);
    }
    publishTelemetry();
}

void subscribeRuntimeTopics() {
    if (!mqtt.connected()) return;
    mqtt.subscribe(topologyTopic.c_str(), 1);
    mqtt.subscribe(directControlTopic.c_str(), 1);
    if (topology.role == "hub") mqtt.subscribe(hubControlTopic.c_str(), 1);
}

void handleTopology(const byte* payload, unsigned int length) {
    if (length == 0) {
        topology = {};
        return;
    }
    JsonDocument document;
    const auto error = deserializeJson(document, payload, length);
    if (error || String(document["schema"] | "") != TOPOLOGY_SCHEMA) return;

    TopologyAssignment next;
    next.networkId = String(document["network_id"] | "");
    next.epoch = document["topology_epoch"].as<std::uint32_t>();
    next.state = String(document["topology_state"] | "");
    next.role = String(document["role"] | "");
    next.transportMode = String(document["transport_mode"] | "");
    next.activeHubMac = String(document["active_hub_mac"] | "");
    next.valid = !next.networkId.isEmpty()
        && (next.role == "hub" || next.role == "node")
        && (next.transportMode == "hub"
            || next.transportMode == "relay"
            || next.transportMode == "direct_fallback");
    if (!next.valid || (topology.valid && next.epoch < topology.epoch)) return;

    topology = next;
    subscribeRuntimeTopics();
    publishTopologyAck();
    publishPresence("online");
    telemetryRequested = true;
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
    const String incomingTopic(topic);
    if (incomingTopic == topologyTopic) {
        handleTopology(payload, length);
        return;
    }
    JsonDocument document;
    if (deserializeJson(document, payload, length)) return;
    handleOperation(document, incomingTopic == hubControlTopic);
}

void connectWifi() {
    if (WiFi.status() == WL_CONNECTED || BoardConfig::WIFI_SSID[0] == '\0') return;
    const auto current = nowMillis();
    if (
        wifiBeginIssued
        && current - lastWifiAttemptAt < BoardConfig::MQTT_RECONNECT_INTERVAL_MS
    ) {
        return;
    }
    wifiBeginIssued = true;
    lastWifiAttemptAt = current;
    WiFi.begin(BoardConfig::WIFI_SSID, BoardConfig::WIFI_PASSWORD);
}

void connectMqtt() {
    if (mqtt.connected() || WiFi.status() != WL_CONNECTED) return;
    const auto current = nowMillis();
    if (current - lastReconnectAt < BoardConfig::MQTT_RECONNECT_INTERVAL_MS) return;
    lastReconnectAt = current;

    const bool hasCredentials = BoardConfig::MQTT_USERNAME[0] != '\0';
    const bool connected = hasCredentials
        ? mqtt.connect(
            deviceMac.c_str(),
            BoardConfig::MQTT_USERNAME,
            BoardConfig::MQTT_PASSWORD
        )
        : mqtt.connect(deviceMac.c_str());
    if (!connected) return;
    subscribeRuntimeTopics();
    publishTopologyAck();
    publishPresence("online");
    telemetryRequested = true;
}

void updateLocalButton() {
    const auto current = nowMillis();
    const bool nextRawPressed = digitalRead(BoardConfig::MUTE_BUTTON_PIN) == LOW;
    if (nextRawPressed != rawButtonPressed) {
        rawButtonPressed = nextRawPressed;
        buttonChangedAt = current;
    }
    if (
        rawButtonPressed == stableButtonPressed
        || current - buttonChangedAt < BoardConfig::BUTTON_DEBOUNCE_MS
    ) {
        return;
    }
    stableButtonPressed = rawButtonPressed;
    if (!stableButtonPressed) return;

    if (
        siren.mute(
            BoardConfig::LOCAL_MUTE_SECONDS,
            nowEpochSeconds(),
            current
    ) == SirenCommandResult::Applied
    ) {
        pendingMuteUntilEpoch = 0;
        muteRestorePending = false;
        persistSafetyState();
        writeBuzzer();
        markStateChanged();
    }
}

void restorePersistentState() {
    bootId = preferences.getUInt("bootId", 0) + 1;
    preferences.putUInt("bootId", bootId);
    const auto storedState = preferences.getUChar("incState", 0);
    incidentState = storedState <= static_cast<std::uint8_t>(IncidentState::Acknowledged)
        ? static_cast<IncidentState>(storedState)
        : IncidentState::Idle;
    activeIncidentId = preferences.getString("incidentId", "");
    pendingMuteUntilEpoch = preferences.getULong64("muteUntil", 0);
    muteRestorePending = pendingMuteUntilEpoch != 0;
}

void buildTopics() {
    directControlTopic = "smarthome/" + deviceMac + "/control";
    hubControlTopic = "smarthome/" + deviceMac + "/hub/control";
    topologyTopic = "smarthome/" + deviceMac + "/topology";
    telemetryTopic = "smarthome/" + deviceMac + "/telemetry";
    ackTopic = "smarthome/" + deviceMac + "/ack";
    statusTopic = "smarthome/" + deviceMac + "/status";
}

}  // namespace

void setup() {
    Serial.begin(115200);
    pinMode(BoardConfig::MQ2_ANALOG_PIN, INPUT);
    pinMode(BoardConfig::FLAME_DIGITAL_PIN, INPUT_PULLUP);
    pinMode(BoardConfig::MUTE_BUTTON_PIN, INPUT_PULLUP);
    pinMode(BoardConfig::BUZZER_PIN, OUTPUT);
    writeBuzzer();

    WiFi.mode(WIFI_STA);
    deviceMac = WiFi.macAddress();
    deviceMac.toUpperCase();
    buildTopics();

    preferences.begin("hazard-v2", false);
    configTime(0, 0, "pool.ntp.org", "time.google.com");
    restorePersistentState();
    dht.begin();

    mqtt.setServer(BoardConfig::MQTT_HOST, BoardConfig::MQTT_PORT);
    mqtt.setCallback(mqttCallback);
    mqtt.setBufferSize(BoardConfig::MQTT_BUFFER_BYTES);
    connectWifi();
}

void loop() {
    connectWifi();
    connectMqtt();
    mqtt.loop();

    const auto current = nowMillis();
    updateLocalButton();
    if (muteRestorePending && nowEpochSeconds() != 0) {
        siren.restoreMute(pendingMuteUntilEpoch, nowEpochSeconds(), current);
        pendingMuteUntilEpoch = 0;
        muteRestorePending = false;
        persistSafetyState();
        writeBuzzer();
        markStateChanged();
    }
    if (current - lastSensorAt >= BoardConfig::SENSOR_INTERVAL_MS) {
        lastSensorAt = current;
        updateSensors();
    }

    const auto previousAudible = siren.snapshot().audible;
    const auto previousMuteUntil = siren.snapshot().muteUntilEpochSeconds;
    siren.tick(nowEpochSeconds(), current);
    if (
        previousAudible != siren.snapshot().audible
        || previousMuteUntil != siren.snapshot().muteUntilEpochSeconds
    ) {
        persistSafetyState();
        writeBuzzer();
        markStateChanged();
    }

    if (
        telemetryRequested
        || current - lastTelemetryAt >= BoardConfig::TELEMETRY_INTERVAL_MS
    ) {
        publishTelemetry();
    }
    if (current - lastPresenceAt >= BoardConfig::PRESENCE_INTERVAL_MS) {
        publishPresence("heartbeat");
    }
    delay(5);
}
