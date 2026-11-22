# Published Products

The executable source is `database/catalog-v2`. Every Product composes reusable
capabilities but declares an explicit `ui_profile` for its mini card and detail
screen. Adding a truly new Product may therefore require a new Flutter profile;
existing capability widgets remain reusable.

- `prod_entrance_controller`: SG90 door lock, MPU6050 door position, local
  six-digit PIN authentication, 4x4 keypad events and LCD 4x20 messages.
  ESP32-CAM streaming and face authentication remain planned capabilities.
- `prod_roof_controller`: water sensor, step motor and one local toggle button.
  Rain auto-close is firmware-local and can be enabled/disabled by the app.
- `prod_hazard_mitigation`: flame sensor, MQ2 (gas and smoke), DHT11, siren
  and temporary local mute button. Alarm decisions and reactivation remain
  firmware-local; incidents are acknowledged/reset from the app.
- `prod_irrigation_manager`: virtual controller with soil moisture, reservoir
  state, bounded pump cycles and local automatic policy.
- `prod_security_camera`: live view and playback through the media relay,
  recording to local storage ([camera-contract.md](../architecture/camera-contract.md)).

Reported state is device-authoritative for every Product. Catalog defaults are
firmware/simulator boot defaults and must not be used by backend claim flow to
invent device state.
