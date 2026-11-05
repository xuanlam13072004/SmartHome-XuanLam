#pragma once

#include <array>
#include <cstdint>

// All GPIO values are a reference layout for an ESP32 DevKit. They are not a
// final PCB declaration. Override them with PlatformIO -D flags after checking
// the actual board, servo power rail, I2C pull-ups and keypad wiring.

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

// Lab fallback only. Shipped devices read their per-device password from NVS
// (namespace "factory", key "mqttPassword"); the MQTT username is always the MAC.
#ifndef SMARTHOME_MQTT_PASSWORD
#define SMARTHOME_MQTT_PASSWORD ""
#endif

// Development-only bootstrap. Production devices must receive the PIN through
// the encrypted credential channel; never commit a real PIN here.
#ifndef SMARTHOME_BOOTSTRAP_PIN
#define SMARTHOME_BOOTSTRAP_PIN ""
#endif

#ifndef SMARTHOME_SERVO_PIN
#define SMARTHOME_SERVO_PIN 18
#endif

#ifndef SMARTHOME_I2C_SDA_PIN
#define SMARTHOME_I2C_SDA_PIN 21
#endif

#ifndef SMARTHOME_I2C_SCL_PIN
#define SMARTHOME_I2C_SCL_PIN 22
#endif

#ifndef SMARTHOME_LCD_ADDRESS
#define SMARTHOME_LCD_ADDRESS 0x27
#endif

#ifndef SMARTHOME_MPU_ADDRESS
#define SMARTHOME_MPU_ADDRESS 0x68
#endif

#ifndef SMARTHOME_KEYPAD_ROW_1
#define SMARTHOME_KEYPAD_ROW_1 32
#endif
#ifndef SMARTHOME_KEYPAD_ROW_2
#define SMARTHOME_KEYPAD_ROW_2 33
#endif
#ifndef SMARTHOME_KEYPAD_ROW_3
#define SMARTHOME_KEYPAD_ROW_3 25
#endif
#ifndef SMARTHOME_KEYPAD_ROW_4
#define SMARTHOME_KEYPAD_ROW_4 26
#endif
#ifndef SMARTHOME_KEYPAD_COL_1
#define SMARTHOME_KEYPAD_COL_1 27
#endif
#ifndef SMARTHOME_KEYPAD_COL_2
#define SMARTHOME_KEYPAD_COL_2 14
#endif
#ifndef SMARTHOME_KEYPAD_COL_3
#define SMARTHOME_KEYPAD_COL_3 13
#endif
#ifndef SMARTHOME_KEYPAD_COL_4
#define SMARTHOME_KEYPAD_COL_4 4
#endif

// 0 measures pitch from accelerometer X, 1 measures roll from accelerometer Y.
// Select this after mounting the MPU6050 on the real door.
#ifndef SMARTHOME_MPU_DOOR_AXIS
#define SMARTHOME_MPU_DOOR_AXIS 0
#endif

namespace BoardConfig {

inline constexpr char WIFI_SSID[] = SMARTHOME_WIFI_SSID;
inline constexpr char WIFI_PASSWORD[] = SMARTHOME_WIFI_PASSWORD;
inline constexpr char MQTT_HOST[] = SMARTHOME_MQTT_HOST;
inline constexpr std::uint16_t MQTT_PORT = SMARTHOME_MQTT_PORT;
inline constexpr char MQTT_PASSWORD[] = SMARTHOME_MQTT_PASSWORD;
inline constexpr char BOOTSTRAP_PIN[] = SMARTHOME_BOOTSTRAP_PIN;

inline constexpr char PRODUCT_ID[] = "prod_entrance_controller";
inline constexpr std::uint16_t CATALOG_REVISION = 6;
inline constexpr char FIRMWARE_VERSION[] = "2.3.0";

inline constexpr std::uint8_t SERVO_PIN = SMARTHOME_SERVO_PIN;
inline constexpr std::uint8_t I2C_SDA_PIN = SMARTHOME_I2C_SDA_PIN;
inline constexpr std::uint8_t I2C_SCL_PIN = SMARTHOME_I2C_SCL_PIN;
inline constexpr std::uint8_t LCD_ADDRESS = SMARTHOME_LCD_ADDRESS;
inline constexpr std::uint8_t MPU_ADDRESS = SMARTHOME_MPU_ADDRESS;
inline constexpr std::uint8_t MPU_DOOR_AXIS = SMARTHOME_MPU_DOOR_AXIS;
inline constexpr std::array<std::uint8_t, 4> KEYPAD_ROWS = {
    SMARTHOME_KEYPAD_ROW_1,
    SMARTHOME_KEYPAD_ROW_2,
    SMARTHOME_KEYPAD_ROW_3,
    SMARTHOME_KEYPAD_ROW_4,
};
inline constexpr std::array<std::uint8_t, 4> KEYPAD_COLS = {
    SMARTHOME_KEYPAD_COL_1,
    SMARTHOME_KEYPAD_COL_2,
    SMARTHOME_KEYPAD_COL_3,
    SMARTHOME_KEYPAD_COL_4,
};

inline constexpr std::uint8_t SERVO_LOCKED_DEGREES = 0;
inline constexpr std::uint8_t SERVO_UNLOCKED_DEGREES = 90;
inline constexpr std::uint16_t SERVO_MIN_PULSE_US = 500;
inline constexpr std::uint16_t SERVO_MAX_PULSE_US = 2400;
inline constexpr std::uint32_t SENSOR_INTERVAL_MS = 100;
inline constexpr std::uint32_t TELEMETRY_INTERVAL_MS = 10'000;
inline constexpr std::uint32_t PRESENCE_INTERVAL_MS = 30'000;
inline constexpr std::uint32_t MQTT_RECONNECT_INTERVAL_MS = 5'000;
inline constexpr std::uint16_t MQTT_BUFFER_BYTES = 6144;
inline constexpr float MPU_FILTER_ALPHA = 0.18F;

}  // namespace BoardConfig

