# Product Catalog V1 baseline

This document freezes the functional baseline before the Product V2 clean break.
It is descriptive only; runtime still reads `database/seeds` until the V2 cutover.

| Legacy product | Existing instances | Baseline that must not disappear |
| --- | --- | --- |
| `prod_entrance_controller_v1` | lock, PIN, face, RFID, fingerprint, camera, keypad/button, vibration, LCD, siren | lock state/control, access methods, camera state/control, LCD state, alarm |
| `prod_roof_controller_v1` | cover, rain, illuminance, temperature, humidity, local open/close buttons | roof position/control and outdoor measurements |
| `prod_hazard_mitigation_v1` | gas, flame, smoke, siren, fan, mute button, power monitor | hazard measurements, alarm/ventilation and electrical readings |
| `prod_irrigation_manager_v1` | soil moisture, reservoir level, pump, local button | moisture/level readings and pump control |

## Known V1 constraints

- State is flat, so identical property names on multiple instances can collide.
- Physical inputs have no first-class event contract.
- Operations do not declare permission, risk, state effect or safety constraints.
- Credential values travel through the generic command shape.
- Simulator behavior depends on action-name switches.
- Product IDs encode a version suffix even though the database has no independent catalog revision.

## Clean-break rule

V2 keeps the functional baseline, not the stored V1 data or wire contract. Database
cleanup occurs only after Gateway, MQTT Worker, Simulator and Flutter are all ready
for V2.
