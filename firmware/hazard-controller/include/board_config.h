#pragma once

#include <cstdint>

// Every value in this file can be overridden with a PlatformIO -D build flag.
// The GPIO map is a reference layout for an ESP32 DevKit, not a declaration of
// the final PCB wiring. Verify it against the real board before flashing.

#ifndef SMARTHOME_WIFI_SSID
#define SMARTHOME_WIFI_SSID ""
#endif

#ifndef SMARTHOME_WIFI_PASSWORD
#define SMARTHOME_WIFI_PASSWORD ""
#endif

#ifndef SMARTHOME_MQTT_HOST
#define SMARTHOME_MQTT_HOST "192.168.1.2"
#endif

#ifndef SMARTHOME_MQTT_PORT
#define SMARTHOME_MQTT_PORT 1883
#endif

#ifndef SMARTHOME_MQTT_USERNAME
#define SMARTHOME_MQTT_USERNAME ""
#endif

#ifndef SMARTHOME_MQTT_PASSWORD
#define SMARTHOME_MQTT_PASSWORD ""
#endif

#ifndef SMARTHOME_DHT_PIN
#define SMARTHOME_DHT_PIN 4
#endif

#ifndef SMARTHOME_MQ2_ANALOG_PIN
#define SMARTHOME_MQ2_ANALOG_PIN 34
#endif

#ifndef SMARTHOME_FLAME_DIGITAL_PIN
#define SMARTHOME_FLAME_DIGITAL_PIN 27
#endif

#ifndef SMARTHOME_BUZZER_PIN
#define SMARTHOME_BUZZER_PIN 26
#endif

#ifndef SMARTHOME_MUTE_BUTTON_PIN
#define SMARTHOME_MUTE_BUTTON_PIN 25
#endif

#ifndef SMARTHOME_FLAME_ACTIVE_LEVEL
#define SMARTHOME_FLAME_ACTIVE_LEVEL 0
#endif

#ifndef SMARTHOME_BUZZER_ACTIVE_LEVEL
#define SMARTHOME_BUZZER_ACTIVE_LEVEL 1
#endif

namespace BoardConfig {

inline constexpr char WIFI_SSID[] = SMARTHOME_WIFI_SSID;
inline constexpr char WIFI_PASSWORD[] = SMARTHOME_WIFI_PASSWORD;
inline constexpr char MQTT_HOST[] = SMARTHOME_MQTT_HOST;
inline constexpr std::uint16_t MQTT_PORT = SMARTHOME_MQTT_PORT;
inline constexpr char MQTT_USERNAME[] = SMARTHOME_MQTT_USERNAME;
inline constexpr char MQTT_PASSWORD[] = SMARTHOME_MQTT_PASSWORD;

inline constexpr char PRODUCT_ID[] = "prod_hazard_mitigation";
inline constexpr std::uint16_t CATALOG_REVISION = 2;
inline constexpr char FIRMWARE_VERSION[] = "2.1.0";

inline constexpr std::uint8_t DHT_PIN = SMARTHOME_DHT_PIN;
inline constexpr std::uint8_t MQ2_ANALOG_PIN = SMARTHOME_MQ2_ANALOG_PIN;
inline constexpr std::uint8_t FLAME_DIGITAL_PIN = SMARTHOME_FLAME_DIGITAL_PIN;
inline constexpr std::uint8_t BUZZER_PIN = SMARTHOME_BUZZER_PIN;
inline constexpr std::uint8_t MUTE_BUTTON_PIN = SMARTHOME_MUTE_BUTTON_PIN;
inline constexpr std::uint8_t FLAME_ACTIVE_LEVEL = SMARTHOME_FLAME_ACTIVE_LEVEL;
inline constexpr std::uint8_t BUZZER_ACTIVE_LEVEL = SMARTHOME_BUZZER_ACTIVE_LEVEL;

inline constexpr std::uint32_t SENSOR_INTERVAL_MS = 2'000;
inline constexpr std::uint32_t TELEMETRY_INTERVAL_MS = 10'000;
inline constexpr std::uint32_t PRESENCE_INTERVAL_MS = 30'000;
inline constexpr std::uint32_t MQTT_RECONNECT_INTERVAL_MS = 5'000;
inline constexpr std::uint32_t MQ2_WARMUP_MS = 30'000;
inline constexpr std::uint32_t BUTTON_DEBOUNCE_MS = 80;
inline constexpr std::uint32_t FLAME_DEBOUNCE_MS = 250;

// These normalized thresholds are intentionally centralized because the MQ2
// calibration is still an open hardware question in hardware-profile.json.
// They are suitable for integration testing only and must be calibrated before
// the device is treated as a production safety instrument.
inline constexpr float GAS_WARNING_THRESHOLD = 50.0F;
inline constexpr float GAS_ALARM_THRESHOLD = 70.0F;
inline constexpr float SMOKE_WARNING_THRESHOLD = 45.0F;
inline constexpr float SMOKE_ALARM_THRESHOLD = 65.0F;

inline constexpr std::uint16_t LOCAL_MUTE_SECONDS = 60;
inline constexpr std::uint16_t MQTT_BUFFER_BYTES = 4096;

}  // namespace BoardConfig
