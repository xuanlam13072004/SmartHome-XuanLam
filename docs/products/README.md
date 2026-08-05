# Published Products

The executable source is `database/catalog-v2`. Every Product composes reusable
capabilities but declares an explicit `ui_profile` for its mini card and detail
screen. Adding a truly new Product may therefore require a new Flutter profile;
existing capability widgets remain reusable.

- `prod_entrance_controller`: SG90 door lock, ESP32-CAM protected sessions,
  local face/PIN authentication, 4x4 keypad events and LCD 4x20 messages.
- `prod_roof_controller`: water sensor, step motor and one local toggle button.
  Rain auto-close is firmware-local and can be enabled/disabled by the app.
- `prod_hazard_monitor`: flame sensor, MQ2, DHT11, buzzer and temporary local
  mute button. Alarm decisions and reactivation remain firmware-local.
- `prod_irrigation_manager`: proposed virtual controller with soil moisture,
  reservoir state, bounded pump cycles and local automatic policy.

Reported state is device-authoritative for every Product. Catalog defaults are
firmware/simulator boot defaults and must not be used by backend claim flow to
invent device state.
