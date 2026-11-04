#include <Arduino.h>
#include <ArduinoJson.h>
#include <Adafruit_MPU6050.h>
#include <ESP32Servo.h>
#include <Keypad.h>
#include <LiquidCrystal_I2C.h>
#include <Preferences.h>
#include <PubSubClient.h>
#include <WiFi.h>
#include <Wire.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <ctime>

#include "board_config.h"
#include "entrance_state_machine.h"
#include "secure_pin_store.h"

namespace {

constexpr char TOPOLOGY_SCHEMA[] = "device.topology.assignment.v2";
constexpr char OPERATION_SCHEMA[] = "device.operation.v2";
constexpr char CREDENTIAL_SCHEMA[] = "device.credential.v2";
constexpr std::uint32_t VALID_EPOCH_FLOOR = 1'700'000'000UL;
constexpr std::uint32_t REMOTE_OPERATION_TIMEOUT_MS = 10'000;

struct TopologyAssignment {
    bool valid = false;
    String networkId;
    std::uint32_t epoch = 0;
    String state;
    String role;
    String transportMode;
    String activeHubMac;
};

struct AckRoute {
    String mode;
    String networkId;
    std::uint32_t topologyEpoch = 0;
    String hubMac;
};

struct OperationReceipt {
    String id;
    String status;
    String reason;
};

struct PendingOperation {
    bool active = false;
    String id;
    String targetDeviceId;
    String expectedLockState;
    AckRoute route;
    std::uint64_t deadlineMillis = 0;
};

WiFiClient wifiClient;
PubSubClient mqtt(wifiClient);
Preferences runtimePreferences;
SecurePinStore pinStore;
EntranceController entrance;
Servo lockServo;
Adafruit_MPU6050 mpu;
LiquidCrystal_I2C lcd(BoardConfig::LCD_ADDRESS, 20, 4);

char keypadKeys[4][4] = {
    {'1', '2', '3', 'A'},
    {'4', '5', '6', 'B'},
    {'7', '8', '9', 'C'},
    {'*', '0', '#', 'D'},
};
byte keypadRows[4] = {
    BoardConfig::KEYPAD_ROWS[0], BoardConfig::KEYPAD_ROWS[1],
    BoardConfig::KEYPAD_ROWS[2], BoardConfig::KEYPAD_ROWS[3],
};
byte keypadCols[4] = {
    BoardConfig::KEYPAD_COLS[0], BoardConfig::KEYPAD_COLS[1],
    BoardConfig::KEYPAD_COLS[2], BoardConfig::KEYPAD_COLS[3],
};
Keypad keypad(makeKeymap(keypadKeys), keypadRows, keypadCols, 4, 4);

TopologyAssignment topology;
PendingOperation pendingOperation;
OperationReceipt receipts[8];
std::size_t nextReceipt = 0;
EntranceEvent pendingEvent;
bool hasPendingEvent = false;

String deviceMac;
String mqttPassword;
String directControlTopic;
String hubControlTopic;
String topologyTopic;
String telemetryTopic;
String eventTopic;
String ackTopic;
String statusTopic;

bool mpuAvailable = false;
bool mpuCalibrated = false;
float mpuClosedReference = 0.0F;
float filteredDoorAngle = 0.0F;
std::uint8_t invalidMpuSamples = 0;

std::uint32_t bootId = 0;
std::uint32_t telemetrySequence = 0;
std::uint32_t eventSequence = 0;
std::uint32_t stateVersion = 0;
std::uint64_t lastSensorAt = 0;
std::uint64_t lastTelemetryAt = 0;
std::uint64_t lastPresenceAt = 0;
std::uint64_t lastReconnectAt = 0;
std::uint64_t lastWifiAttemptAt = 0;
bool wifiBeginIssued = false;
bool telemetryRequested = true;
EntranceLockState appliedServoState = EntranceLockState::Fault;
EntranceLockState persistedStableState = EntranceLockState::Fault;

std::uint64_t nowMillis() {
    // Arduino millis() wraps after roughly 49.7 days. Extend it to a monotonic
    // 64-bit clock so a wrap cannot bypass or indefinitely extend safety timers.
    static std::uint32_t previous = 0;
    static std::uint64_t epoch = 0;
    const std::uint32_t current = millis();
    if (current < previous) epoch += (std::uint64_t{1} << 32);
    previous = current;
    return epoch + current;
}

std::uint64_t nowEpochSeconds() {
    const std::time_t value = time(nullptr);
    return value >= static_cast<std::time_t>(VALID_EPOCH_FLOOR)
        ? static_cast<std::uint64_t>(value)
        : 0;
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

bool hasServerTransport() {
    // A Node assigned to relay must send through the selected embedded-radio
    // adapter and the Hub must publish it with the Node relay envelope. This
    // reference firmware intentionally has no board-specific radio driver yet,
    // so publishing that payload directly over MQTT would forge the route.
    // Wait for direct_fallback instead of claiming a relay path that does not
    // physically exist.
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

void renderLcd() {
    const auto& snapshot = entrance.snapshot();
    for (std::size_t row = 0; row < snapshot.lcdLines.size(); ++row) {
        lcd.setCursor(0, row);
        const char* line = snapshot.lcdLines[row].data();
        std::size_t column = 0;
        for (; column < 20 && line[column] != '\0'; ++column) lcd.print(line[column]);
        for (; column < 20; ++column) lcd.print(' ');
    }
}

bool persistStableLockState(EntranceLockState state) {
    if (state != EntranceLockState::Locked && state != EntranceLockState::Unlocked) return false;
    const char* value = state == EntranceLockState::Locked ? "locked" : "unlocked";
    if (runtimePreferences.putString("stableLock", value) == 0) return false;
    persistedStableState = state;
    return true;
}

void applyServoForSnapshot() {
    const auto& snapshot = entrance.snapshot();
    EntranceLockState target = snapshot.lockState;
    if (
        target == EntranceLockState::Locking
        && (
            snapshot.sensorState != EntranceSensorState::Ready
            || snapshot.doorState != EntranceDoorState::Closed
        )
    ) {
        target = EntranceLockState::Unlocked;
    }
    if (target == EntranceLockState::Fault) target = EntranceLockState::Unlocked;
    if (target == appliedServoState) return;

    if (target == EntranceLockState::Locked || target == EntranceLockState::Locking) {
        lockServo.write(BoardConfig::SERVO_LOCKED_DEGREES);
    } else {
        lockServo.write(BoardConfig::SERVO_UNLOCKED_DEGREES);
    }
    appliedServoState = target;
}

void syncControllerState() {
    if (!entrance.consumeChanged()) return;
    ++stateVersion;
    applyServoForSnapshot();
    renderLcd();
    const auto stableState = entrance.snapshot().lockState;
    if (
        (stableState == EntranceLockState::Locked || stableState == EntranceLockState::Unlocked)
        && stableState != persistedStableState
    ) {
        persistStableLockState(stableState);
    }
    telemetryRequested = true;
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

AckRoute captureRoute(JsonObjectConst route) {
    return {
        String(route["mode"] | ""),
        String(route["network_id"] | ""),
        route["topology_epoch"].as<std::uint32_t>(),
        String(route["hub_mac"] | ""),
    };
}

void publishOperationAck(
    const String& operationId,
    const String& targetDeviceId,
    const char* status,
    const char* reason,
    const AckRoute& route
) {
    JsonDocument document;
    document["schema"] = "device.operation.ack.v2";
    document["operation_id"] = operationId;
    document["device_id"] = targetDeviceId;
    document["status"] = status;
    document["observed_at"] = isoTimestamp();
    if (reason && reason[0] != '\0') document["reason_code"] = reason;
    JsonObject transport = document["transport"].to<JsonObject>();
    transport["mode"] = route.mode;
    transport["network_id"] = route.networkId;
    transport["topology_epoch"] = route.topologyEpoch;
    if (!route.hubMac.isEmpty()) transport["hub_mac"] = route.hubMac;
    publishDocument(ackTopic, document);
}

void publishCredentialAck(
    const String& jobId,
    const char* status,
    const char* reason = ""
) {
    JsonDocument document;
    document["schema"] = "device.credential.ack.v2";
    document["job_id"] = jobId;
    document["device_id"] = deviceMac;
    document["status"] = status;
    document["observed_at"] = isoTimestamp();
    if (reason && reason[0] != '\0') document["reason_code"] = reason;
    publishDocument(ackTopic, document);
}

bool routeMatches(JsonObjectConst route, bool relayedTarget) {
    if (!topology.valid || route.isNull()) return false;
    if (String(route["network_id"] | "") != topology.networkId) return false;
    if (route["topology_epoch"].as<std::uint32_t>() != topology.epoch) return false;
    const String mode = route["mode"] | "";
    if (relayedTarget) return topology.role == "hub" && mode == "relay";
    return mode == topology.transportMode;
}

void completePendingOperation() {
    if (!pendingOperation.active) return;
    const auto& snapshot = entrance.snapshot();
    const String actual = EntranceController::lockStateName(snapshot.lockState);
    if (
        actual == pendingOperation.expectedLockState
        && persistedStableState == snapshot.lockState
    ) {
        rememberReceipt(pendingOperation.id, "succeeded");
        publishOperationAck(
            pendingOperation.id,
            pendingOperation.targetDeviceId,
            "succeeded",
            "",
            pendingOperation.route
        );
        pendingOperation = {};
        telemetryRequested = true;
        return;
    }
    const bool unsafeFailure = pendingOperation.expectedLockState == "locked"
        && snapshot.lockState == EntranceLockState::Unlocked
        && snapshot.phase == EntrancePhase::SensorFault;
    const bool timedOut = nowMillis() >= pendingOperation.deadlineMillis;
    if (!unsafeFailure && !timedOut) return;
    const char* reason = unsafeFailure ? "UNSAFE_DOOR_POSITION" : "ACTUATOR_TIMEOUT";
    rememberReceipt(pendingOperation.id, "rejected", reason);
    publishOperationAck(
        pendingOperation.id,
        pendingOperation.targetDeviceId,
        "rejected",
        reason,
        pendingOperation.route
    );
    pendingOperation = {};
}

void publishTopologyAck() {
    if (!topology.valid || topology.role != "hub" || topology.state != "electing") return;
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
    if (!hasServerTransport()) return;
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
    if (!hasServerTransport()) return;
    const auto& snapshot = entrance.snapshot();
    JsonDocument document;
    ++telemetrySequence;
    document["schema"] = "device.telemetry.v2";
    document["event_id"] = deviceMac + ":" + String(bootId) + ":" + String(telemetrySequence);
    document["device_id"] = deviceMac;
    document["product_id"] = BoardConfig::PRODUCT_ID;
    document["catalog_revision"] = BoardConfig::CATALOG_REVISION;
    document["state_version"] = stateVersion;
    document["seq"] = telemetrySequence;
    document["observed_at"] = isoTimestamp();

    JsonObject instances = document["instances"].to<JsonObject>();
    instances["main_lock"]["reported"]["lock_state"] =
        EntranceController::lockStateName(snapshot.lockState);
    JsonObject position = instances["door_position"]["reported"].to<JsonObject>();
    position["door_state"] = EntranceController::doorStateName(snapshot.doorState);
    position["door_angle_degrees"] = snapshot.doorAngleDegrees;
    position["position_sensor_state"] = EntranceController::sensorStateName(snapshot.sensorState);
    instances["pin_auth"]["reported"]["pin_configured"] = snapshot.pinConfigured;
    JsonObject display = instances["lcd"]["reported"].to<JsonObject>();
    JsonArray lines = display["displayed_lines"].to<JsonArray>();
    for (const auto& line : snapshot.lcdLines) lines.add(line.data());
    display["display_source"] = snapshot.displaySource.data();

    JsonObject diagnostics = document["diagnostics"]["system"].to<JsonObject>();
    diagnostics["online"] = mqtt.connected();
    if (WiFi.status() == WL_CONNECTED) diagnostics["wifi_rssi"] = WiFi.RSSI();
    else diagnostics["wifi_rssi"] = nullptr;
    diagnostics["uptime"] = nowMillis() / 1000ULL;
    diagnostics["firmware_version"] = BoardConfig::FIRMWARE_VERSION;
    diagnostics["firmware_status"] = mpuAvailable ? "healthy" : "fault";
    appendTransport(document["transport"].to<JsonObject>(), topology);

    if (publishDocument(telemetryTopic, document)) {
        telemetryRequested = false;
        lastTelemetryAt = nowMillis();
    }
}

bool publishEntranceEvent(const EntranceEvent& event) {
    if (!hasServerTransport()) return false;
    const char* instanceId = nullptr;
    const char* eventName = nullptr;
    JsonDocument document;
    JsonObject data = document["data"].to<JsonObject>();
    switch (event.type) {
        case EntranceEventType::KeypadAuthenticationRequested:
            instanceId = "keypad";
            eventName = "keypad_action";
            data["action"] = "authentication_requested";
            break;
        case EntranceEventType::KeypadAuthenticationCancelled:
            instanceId = "keypad";
            eventName = "keypad_action";
            data["action"] = "authentication_cancelled";
            break;
        case EntranceEventType::KeypadAuthenticationSubmitted:
            instanceId = "keypad";
            eventName = "keypad_action";
            data["action"] = "authentication_submitted";
            break;
        case EntranceEventType::PinAccessGranted:
            instanceId = "pin_auth";
            eventName = "pin_access_granted";
            data["credential_id"] = "primary";
            break;
        case EntranceEventType::PinAccessDenied:
            instanceId = "pin_auth";
            eventName = "pin_access_denied";
            data["attempts_remaining"] = event.attemptsRemaining;
            break;
        case EntranceEventType::PinLockedOut:
            instanceId = "pin_auth";
            eventName = "pin_locked_out";
            data["lockout_seconds"] = EntranceController::PinLockoutMs / 1000;
            break;
        case EntranceEventType::LockChanged:
            instanceId = "main_lock";
            eventName = "lock_changed";
            data["state"] = EntranceController::lockStateName(event.lockState);
            data["source"] = EntranceController::sourceName(event.source);
            data["reason"] = event.reason.data();
            break;
        case EntranceEventType::DoorOpened:
            instanceId = "door_position";
            eventName = "door_opened";
            data["angle_degrees"] = event.angleDegrees;
            break;
        case EntranceEventType::DoorClosed:
            instanceId = "door_position";
            eventName = "door_closed";
            data["angle_degrees"] = event.angleDegrees;
            break;
        case EntranceEventType::DoorPositionFault:
            instanceId = "door_position";
            eventName = "door_position_fault";
            data["reason"] = event.reason.data();
            break;
        case EntranceEventType::None:
            return true;
    }

    ++eventSequence;
    document["schema"] = "device.event.v2";
    document["event_id"] = deviceMac + ":event:" + String(bootId) + ":" + String(eventSequence);
    document["device_id"] = deviceMac;
    document["product_id"] = BoardConfig::PRODUCT_ID;
    document["catalog_revision"] = BoardConfig::CATALOG_REVISION;
    document["seq"] = eventSequence;
    document["instance_id"] = instanceId;
    document["event_name"] = eventName;
    document["device_uptime_ms"] = nowMillis();
    if (nowEpochSeconds() != 0) document["occurred_at"] = isoTimestamp();
    appendTransport(document["transport"].to<JsonObject>(), topology);
    return publishDocument(eventTopic, document);
}

void drainEvents() {
    if (!mqtt.connected() || !hasServerTransport()) return;
    while (true) {
        if (!hasPendingEvent && !entrance.popEvent(pendingEvent)) return;
        hasPendingEvent = true;
        if (!publishEntranceEvent(pendingEvent)) return;
        hasPendingEvent = false;
    }
}

float readRawOrientation() {
    if (!mpuAvailable) return NAN;
    sensors_event_t acceleration{};
    sensors_event_t gyroscope{};
    sensors_event_t temperature{};
    mpu.getEvent(&acceleration, &gyroscope, &temperature);
    const float x = acceleration.acceleration.x;
    const float y = acceleration.acceleration.y;
    const float z = acceleration.acceleration.z;
    const float magnitude = std::sqrt(x * x + y * y + z * z);
    if (!std::isfinite(magnitude) || magnitude < 3.0F || magnitude > 20.0F) return NAN;
    constexpr float radiansToDegrees = 57.2957795F;
    if (BoardConfig::MPU_DOOR_AXIS == 1) {
        return std::atan2(y, std::sqrt(x * x + z * z)) * radiansToDegrees;
    }
    return std::atan2(x, std::sqrt(y * y + z * z)) * radiansToDegrees;
}

float relativeDoorAngle(float raw) {
    float delta = std::fabs(raw - mpuClosedReference);
    while (delta > 180.0F) delta = std::fabs(delta - 360.0F);
    return std::clamp(delta, 0.0F, 180.0F);
}

bool calibrateClosedDoor() {
    if (!mpuAvailable) return false;
    float sum = 0.0F;
    std::size_t count = 0;
    for (std::size_t sample = 0; sample < 30; ++sample) {
        const float value = readRawOrientation();
        if (std::isfinite(value)) {
            sum += value;
            ++count;
        }
        delay(10);
    }
    if (count < 24) return false;
    mpuClosedReference = sum / static_cast<float>(count);
    if (runtimePreferences.putFloat("mpuClosed", mpuClosedReference) == 0) return false;
    runtimePreferences.putBool("mpuCal", true);
    mpuCalibrated = true;
    filteredDoorAngle = 0.0F;
    invalidMpuSamples = 0;
    entrance.updateDoorPosition(0.0F, EntranceSensorState::Ready, nowMillis());
    return true;
}

void updateDoorSensor() {
    if (!mpuAvailable) {
        entrance.updateDoorPosition(
            filteredDoorAngle,
            EntranceSensorState::Fault,
            nowMillis()
        );
        return;
    }
    if (!mpuCalibrated) {
        entrance.updateDoorPosition(
            0.0F,
            EntranceSensorState::Calibrating,
            nowMillis()
        );
        return;
    }
    const float raw = readRawOrientation();
    if (!std::isfinite(raw)) {
        invalidMpuSamples = std::min<std::uint8_t>(10, invalidMpuSamples + 1);
        if (invalidMpuSamples >= 3) {
            entrance.updateDoorPosition(
                filteredDoorAngle,
                EntranceSensorState::Fault,
                nowMillis()
            );
        }
        return;
    }
    invalidMpuSamples = 0;
    const float measured = relativeDoorAngle(raw);
    filteredDoorAngle += BoardConfig::MPU_FILTER_ALPHA * (measured - filteredDoorAngle);
    entrance.updateDoorPosition(
        std::round(filteredDoorAngle * 10.0F) / 10.0F,
        EntranceSensorState::Ready,
        nowMillis()
    );
}

void handleKeypad() {
    const char key = keypad.getKey();
    if (key == NO_KEY) return;
    if (key == 'D' && !mpuCalibrated) {
        calibrateClosedDoor();
        syncControllerState();
        return;
    }
    const auto result = entrance.handleKey(key, nowMillis());
    if (result == EntranceActionResult::PinVerificationRequired) {
        const bool matches = pinStore.verify(entrance.enteredPin());
        entrance.completePinVerification(matches, nowMillis());
    }
    syncControllerState();
}

bool parseCustomLines(
    JsonObjectConst input,
    std::array<std::array<char, 21>, 4>& lines
) {
    JsonArrayConst source = input["lines"].as<JsonArrayConst>();
    if (source.isNull() || source.size() != 4) return false;
    for (std::size_t row = 0; row < 4; ++row) {
        const char* value = source[row].as<const char*>();
        if (!value || std::strlen(value) > 20) return false;
        lines[row].fill('\0');
        std::strncpy(lines[row].data(), value, 20);
    }
    return true;
}

void rejectOperation(
    const String& operationId,
    const String& targetDeviceId,
    const AckRoute& route,
    const char* reason
) {
    rememberReceipt(operationId, "rejected", reason);
    publishOperationAck(operationId, targetDeviceId, "rejected", reason, route);
}

void handleOperation(JsonDocument& document, bool receivedOnHubTopic) {
    const String operationId = document["operation_id"] | "";
    const String targetDeviceId = document["target_device_id"] | "";
    JsonObjectConst route = document["route"].as<JsonObjectConst>();
    if (operationId.isEmpty() || targetDeviceId.isEmpty() || route.isNull()) return;
    const AckRoute ackRoute = captureRoute(route);

    if (auto* receipt = findReceipt(operationId)) {
        publishOperationAck(
            operationId,
            targetDeviceId,
            receipt->status.c_str(),
            receipt->reason.c_str(),
            ackRoute
        );
        return;
    }
    if (pendingOperation.active && pendingOperation.id == operationId) return;

    const bool relayedTarget = targetDeviceId != deviceMac;
    const bool identityMatches = String(document["product_id"] | "") == BoardConfig::PRODUCT_ID
        && document["catalog_revision"].as<std::uint16_t>() == BoardConfig::CATALOG_REVISION;
    if (!identityMatches || !routeMatches(route, relayedTarget)) {
        rejectOperation(operationId, targetDeviceId, ackRoute, "CONTRACT_OR_ROUTE_MISMATCH");
        return;
    }
    if (relayedTarget) {
        rejectOperation(
            operationId,
            targetDeviceId,
            ackRoute,
            receivedOnHubTopic
                ? "EMBEDDED_RELAY_TRANSPORT_UNCONFIGURED"
                : "INVALID_OPERATION_TARGET"
        );
        return;
    }
    if (pendingOperation.active) {
        rejectOperation(operationId, targetDeviceId, ackRoute, "ACTUATOR_BUSY");
        return;
    }

    const String instance = document["instance_id"] | "";
    const String name = document["operation_name"] | "";
    JsonObjectConst input = document["input"].as<JsonObjectConst>();
    if (instance == "main_lock" && (name == "lock" || name == "unlock")) {
        const auto result = name == "lock"
            ? entrance.requestLock(EntranceSource::Remote, "remote_command", nowMillis())
            : entrance.requestUnlock(EntranceSource::Remote, "remote_command", nowMillis());
        if (result == EntranceActionResult::UnsafeDoorPosition) {
            rejectOperation(operationId, targetDeviceId, ackRoute, "UNSAFE_DOOR_POSITION");
            return;
        }
        syncControllerState();
        const String expected = name == "lock" ? "locked" : "unlocked";
        if (
            String(EntranceController::lockStateName(entrance.snapshot().lockState)) == expected
            && persistedStableState == entrance.snapshot().lockState
        ) {
            rememberReceipt(operationId, "succeeded");
            publishOperationAck(operationId, targetDeviceId, "succeeded", "", ackRoute);
        } else {
            pendingOperation = {
                true,
                operationId,
                targetDeviceId,
                expected,
                ackRoute,
                nowMillis() + REMOTE_OPERATION_TIMEOUT_MS,
            };
        }
        telemetryRequested = true;
        return;
    }

    if (instance == "lcd" && name == "set_custom_message") {
        std::array<std::array<char, 21>, 4> lines{};
        if (!parseCustomLines(input, lines)) {
            rejectOperation(operationId, targetDeviceId, ackRoute, "INVALID_LCD_LINES");
            return;
        }
        entrance.setCustomDisplay(lines);
    } else if (instance == "lcd" && name == "clear_custom_message") {
        entrance.clearCustomDisplay();
    } else {
        rejectOperation(operationId, targetDeviceId, ackRoute, "UNSUPPORTED_OPERATION");
        return;
    }
    syncControllerState();
    rememberReceipt(operationId, "succeeded");
    publishOperationAck(operationId, targetDeviceId, "succeeded", "", ackRoute);
    telemetryRequested = true;
}

void handleCredential(JsonDocument& document, bool receivedOnHubTopic) {
    const String jobId = document["job_id"] | "";
    const String targetDeviceId = document["target_device_id"] | "";
    JsonObjectConst route = document["route"].as<JsonObjectConst>();
    if (jobId.isEmpty() || targetDeviceId.isEmpty() || route.isNull()) return;
    const bool relayedTarget = targetDeviceId != deviceMac;
    const bool identityMatches = String(document["product_id"] | "") == BoardConfig::PRODUCT_ID
        && document["catalog_revision"].as<std::uint16_t>() == BoardConfig::CATALOG_REVISION;
    if (!identityMatches || !routeMatches(route, relayedTarget)) {
        publishCredentialAck(jobId, "rejected", "CONTRACT_OR_ROUTE_MISMATCH");
        return;
    }
    if (relayedTarget) {
        publishCredentialAck(
            jobId,
            "rejected",
            receivedOnHubTopic
                ? "EMBEDDED_RELAY_TRANSPORT_UNCONFIGURED"
                : "INVALID_CREDENTIAL_TARGET"
        );
        return;
    }
    const String instance = document["instance_id"] | "";
    const String credentialName = document["credential_name"] | "";
    if (
        String(document["action"] | "") != "replace"
        || instance != "pin_auth"
        || credentialName != "pin"
    ) {
        publishCredentialAck(jobId, "rejected", "CREDENTIAL_CONTRACT_MISMATCH");
        return;
    }
    const auto result = pinStore.applyEncryptedEnvelope(
        document["encrypted_envelope"].as<JsonObjectConst>(),
        jobId.c_str(),
        instance.c_str(),
        credentialName.c_str()
    );
    if (result != CredentialApplyResult::Applied) {
        publishCredentialAck(jobId, "rejected", SecurePinStore::resultReason(result));
        return;
    }
    entrance.setPinConfigured(true);
    syncControllerState();
    publishCredentialAck(jobId, "succeeded");
    telemetryRequested = true;
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
    if (
        deserializeJson(document, payload, length)
        || String(document["schema"] | "") != TOPOLOGY_SCHEMA
    ) {
        return;
    }
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
    const String schema = document["schema"] | "";
    const bool receivedOnHubTopic = incomingTopic == hubControlTopic;
    if (schema == OPERATION_SCHEMA) handleOperation(document, receivedOnHubTopic);
    else if (schema == CREDENTIAL_SCHEMA) handleCredential(document, receivedOnHubTopic);
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

// Broker identity (docs/architecture/mqtt-security.md): username is always the
// device MAC; the password is a per-device factory secret in NVS
// namespace "factory", key "mqttPassword". The build flag is a lab fallback only.
String loadMqttPassword() {
    Preferences factory;
    String password;
    if (factory.begin("factory", true)) {
        password = factory.getString("mqttPassword", "");
        factory.end();
    }
    if (password.isEmpty()) password = BoardConfig::MQTT_PASSWORD;
    return password;
}

void connectMqtt() {
    if (mqtt.connected() || WiFi.status() != WL_CONNECTED) return;
    const auto current = nowMillis();
    if (current - lastReconnectAt < BoardConfig::MQTT_RECONNECT_INTERVAL_MS) return;
    lastReconnectAt = current;
    const bool connected = mqtt.connect(
        deviceMac.c_str(),
        deviceMac.c_str(),
        mqttPassword.c_str()
    );
    if (!connected) return;
    subscribeRuntimeTopics();
    publishTopologyAck();
    publishPresence("online");
    telemetryRequested = true;
}

void buildTopics() {
    directControlTopic = "smarthome/" + deviceMac + "/control";
    hubControlTopic = "smarthome/" + deviceMac + "/hub/control";
    topologyTopic = "smarthome/" + deviceMac + "/topology";
    telemetryTopic = "smarthome/" + deviceMac + "/telemetry";
    eventTopic = "smarthome/" + deviceMac + "/events";
    ackTopic = "smarthome/" + deviceMac + "/ack";
    statusTopic = "smarthome/" + deviceMac + "/status";
}

EntranceLockState restorePreferredLockState() {
    return runtimePreferences.getString("stableLock", "locked") == "unlocked"
        ? EntranceLockState::Unlocked
        : EntranceLockState::Locked;
}

void initializeHardwareState() {
    mpuAvailable = mpu.begin(BoardConfig::MPU_ADDRESS, &Wire);
    if (mpuAvailable) {
        mpu.setAccelerometerRange(MPU6050_RANGE_4_G);
        mpu.setGyroRange(MPU6050_RANGE_500_DEG);
        mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
    }
    mpuCalibrated = mpuAvailable && runtimePreferences.getBool("mpuCal", false);
    mpuClosedReference = runtimePreferences.getFloat("mpuClosed", 0.0F);
    EntranceSensorState sensorState = EntranceSensorState::Fault;
    float initialAngle = 0.0F;
    if (mpuAvailable && !mpuCalibrated) {
        sensorState = EntranceSensorState::Calibrating;
    } else if (mpuAvailable) {
        const float raw = readRawOrientation();
        if (std::isfinite(raw)) {
            initialAngle = relativeDoorAngle(raw);
            filteredDoorAngle = initialAngle;
            sensorState = EntranceSensorState::Ready;
        }
    }
    entrance.boot(
        pinStore.configured(),
        sensorState,
        initialAngle,
        nowMillis(),
        restorePreferredLockState()
    );
}

}  // namespace

void setup() {
    Serial.begin(115200);
    Wire.begin(BoardConfig::I2C_SDA_PIN, BoardConfig::I2C_SCL_PIN);
    lcd.init();
    lcd.backlight();

    runtimePreferences.begin("entrance-run", false);
    bootId = runtimePreferences.getUInt("bootId", 0) + 1;
    runtimePreferences.putUInt("bootId", bootId);
    persistedStableState = restorePreferredLockState();
    pinStore.begin();
    if (!pinStore.configured() && BoardConfig::BOOTSTRAP_PIN[0] != '\0') {
        pinStore.replace(BoardConfig::BOOTSTRAP_PIN);
    }

    initializeHardwareState();

    // Determine the safe boot state from NVS + MPU6050 before the servo starts
    // receiving pulses. This keeps sensor I/O out of the small attach-to-write
    // window and prevents a stale default angle from being held during boot.
    lockServo.setPeriodHertz(50);
    lockServo.attach(
        BoardConfig::SERVO_PIN,
        BoardConfig::SERVO_MIN_PULSE_US,
        BoardConfig::SERVO_MAX_PULSE_US
    );
    syncControllerState();

    WiFi.mode(WIFI_STA);
    deviceMac = WiFi.macAddress();
    deviceMac.toUpperCase();
    mqttPassword = loadMqttPassword();
    buildTopics();
    configTime(0, 0, "pool.ntp.org", "time.google.com");
    mqtt.setServer(BoardConfig::MQTT_HOST, BoardConfig::MQTT_PORT);
    mqtt.setCallback(mqttCallback);
    mqtt.setBufferSize(BoardConfig::MQTT_BUFFER_BYTES);
    connectWifi();
}

void loop() {
    connectWifi();
    connectMqtt();
    mqtt.loop();

    handleKeypad();
    const auto current = nowMillis();
    if (current - lastSensorAt >= BoardConfig::SENSOR_INTERVAL_MS) {
        lastSensorAt = current;
        updateDoorSensor();
    }
    entrance.tick(current);
    syncControllerState();
    completePendingOperation();
    drainEvents();

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
