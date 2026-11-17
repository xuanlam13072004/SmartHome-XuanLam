# Rooms ("Phòng")

Status: implemented 2026-11-11, PostgreSQL schema **204** (migration
`database/postgres/migrations/204_rooms.sql`). Target scale: 7–8k accounts,
30k devices.

## Model

Rooms are **personal**. Each account arranges the devices it can see; the owner
of a shared device can keep it in "Cổng chính" while a member keeps it in
"Nhà bố mẹ". Rooms never affect permissions, the device, MQTT or the Simulator.

- `rooms (id, account_id, name, icon, position)`. Name 1–60 characters,
  unique per account ignoring case and spacing (`lower(btrim(name))`). `icon`
  is one of the keys in `api-gateway/src/modules/rooms/schemas.ts`
  (`home, living, bedroom, kitchen, entrance, garden, rooftop, garage, office,
  bathroom, kids, storage`), mirrored by `smarthome_app/lib/features/rooms/room_icons.dart`.
- `device_memberships.room_id` holds the account's room for one device. The
  composite foreign key `(room_id, account_id) → rooms(id, account_id)` makes
  it impossible to put a device in another account's room, and
  `ON DELETE SET NULL (room_id)` (PostgreSQL 15+) turns a deleted room's devices
  into "Chưa xếp phòng" without touching the membership.
- Unpairing a device or losing access deletes the membership row, so the device
  leaves the room automatically. A device shared again starts outside the
  member's rooms.
- At most `MAX_ROOMS_PER_ACCOUNT` (30) rooms. Creating and set-up lock the
  account row, so the limit and positions stay exact under concurrent calls.

## Load

Rooms change rarely and only through the account's own edits, so there is no
cache, no outbox and no realtime event. `GET /devices` already returns each
device's `room_id` (one extra column in the existing query). The app computes
counts, online state, alerts and readings from the device list it already
keeps live over WebSocket; `GET /rooms` is one indexed query per app start.

## API

| Endpoint | Purpose |
|---|---|
| `GET /rooms` | Rooms in display order with `device_count`, plus `limits.max_rooms` |
| `POST /rooms` `{name, icon}` | Create (appended last). `409 ROOM_NAME_TAKEN`, `409 ROOM_LIMIT_REACHED` |
| `PATCH /rooms/:roomId` `{name?, icon?}` | Rename / change icon |
| `DELETE /rooms/:roomId` | Delete; its devices become unassigned |
| `PUT /rooms/order` `{room_ids}` | New order; must list every room once (`400 ROOM_ORDER_MISMATCH`) |
| `POST /rooms/setup` `{rooms:[{name, icon, devices:[mac]}]}` | Apply suggested rooms in one transaction; reuses a room with the same name; skips devices the caller cannot see |
| `PUT /devices/:mac/room` `{room_id \| null}` | Move one visible device (`404 DEVICE_NOT_FOUND`, `404 ROOM_NOT_FOUND`) |

Writes are rate-limited (60/min, set-up 10/min). Tests:
`api-gateway/test/rooms.test.ts`.

## App

- **Phòng**: room cards (device count, offline count, alerts, up to three live
  readings), "Chưa xếp phòng" list with one-tap placement, create / edit /
  delete, drag to reorder, and "Gợi ý xếp phòng" (shown up front while the
  account has no room).
- **Room page** (`/rooms/:roomId`): live summary, "Điều khiển nhanh" (lock /
  unlock, open / close roof, water for the default cycle, silence a sounding
  siren, open the camera), the room's devices and a device chooser.
  Quick controls use the same operation flow as the device page
  (`capability_actions.dart`), so confirmation and password checks still apply.
- **Tổng quan**: room chips filter the device grid.
- **Thêm thiết bị**: optional room; the device page menu has "Chuyển phòng".

Suggestions by product: entrance + camera → "Cổng chính", hazard → "Bếp",
irrigation → "Sân vườn", roof → "Sân thượng". Alerts: fire risk or sounding
siren, empty water tank, lock fault (online devices only).
