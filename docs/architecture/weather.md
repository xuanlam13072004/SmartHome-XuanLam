# Weather ("Vị trí nhà & thời tiết")

The weather at the account's home, from Open-Meteo.com, for three things:

- automations with a weather condition in "Nếu" ("6:00 tưới vườn nếu 12 giờ
  tới không mưa", "17:00 đóng mái nếu 6 giờ tới có mưa");
- the assistant, which answers "chiều nay có mưa không?" from the forecast and
  can draft such automations;
- one line on "Tổng quan" and a forecast on the home location page.

Code: `api-gateway/src/modules/weather/` (provinces, forecast rules, service,
routes), `src/workers/weatherRefresher.ts`, the assistant's
`assistant/weatherLookup.ts`; app `smarthome_app/lib/features/weather/`;
Admin Console page "Thời tiết giả lập".

## Decisions (with the user)

- **A condition, never a trigger.** Weather only goes in "Nếu". The trigger
  kinds (`state`, `event`, `time`) are fixed by a CHECK on `automations` and
  migrations only add, so there is no "Khi thời tiết…". A time trigger plus a
  weather condition covers the real uses (water in the morning unless rain is
  coming, close the roof in the evening if it is).
- **Unknown weather is "not met".** No forecast, a forecast older than 3
  hours, or weather turned off: the condition is false, the automation does
  nothing, and `last_skip_reason = 'weather_unavailable'` says why (the app:
  "Không chạy …: chưa có dự báo thời tiết cho vị trí nhà").
- **A coarse home, never GPS.** One of the 34 provinces and cities (their
  centres), or a ward/commune found by name, rounded to 0.01° (about 1 km).
  The phone's location is never read.
- **Open-Meteo**: free, no key, data under CC BY 4.0, so the app and the
  Console show "Dữ liệu thời tiết: Open-Meteo.com (CC BY 4.0)". Free limits:
  10,000 calls a day, 600 a minute; each location of a request counts as one
  call. The free API is for non-commercial use: a commercial deployment runs
  Open-Meteo itself (open source) and points `WEATHER_API_URL` at it.
- **Mock weather** for demos and tests (`WEATHER_MODE=mock`), set in the Admin
  Console and logged.
- **The assistant never guesses the weather**: it reads the forecast and its
  answer goes through the same number check as history answers.

## The home location

`account_preferences.home_latitude`, `home_longitude`, `home_place` (migration
214), all three set or all empty. `PUT /me/home-location` takes
`{"province": "ha_noi"}` or `{"place": {"name", "latitude", "longitude"}}`
(a search result); a place outside Vietnam's box (latitude 6–24, longitude
102–118) is `WEATHER_LOCATION_OUTSIDE`, an unknown code
`WEATHER_PROVINCE_UNKNOWN`. `DELETE /me/home-location` clears it.

Search (`GET /weather/places?q=`, 20 a minute per account) asks Open-Meteo's
geocoding for places in Vietnam (`countryCode=VN`, `language=vi`), rounds the
results and keeps each query a day in Redis; in mock mode it searches the
provinces. Search counts towards the daily call limit; past it, the provinces
are offered.

## Forecasts

Forecasts are kept per **area of 0.1°** (about 11 km, close to the weather
models' own grid), so neighbours share one:

| Redis key | What |
|---|---|
| `weather:cell:<lat>,<lon>` | the forecast of an area (6 hours) |
| `weather:fetching:<cell>` | one request per area at a time (20 s) |
| `weather:refresh` | one refresh round per interval, across Gateways |
| `weather:calls:<YYYY-MM-DD>` | calls made today (Vietnam day) |
| `weather:places:<query>` | search results (1 day) |
| `weather:mock:<province or all>` | mock weather set in the Console |

A request (`/v1/forecast`) carries up to 50 areas: the current block
(temperature, precipitation, WMO weather code) and three days of hourly
temperature, rain chance, precipitation and weather code, in UTC.

- **"Now"** is the current block during the first hour after the request,
  then the hour of the forecast that holds now.
- **Usable for 3 hours.** Older, every condition reads as unknown.
- **Who fetches**: the app and the assistant when the area's forecast is older
  than `WEATHER_REFRESH_MINUTES` (30); saving an automation with a weather
  condition; and the **refresh rounds**: each Gateway ticks every minute, one
  takes the round per interval (Redis lock) and refreshes the areas of homes
  with an enabled weather automation whose forecast is old, oldest first.
- **Budget.** At most `WEATHER_DAILY_CALL_LIMIT` (8,000) calls a day; a call
  past it is refused and logged. Rounds use at most 80% of it, spread over
  the rounds left today, so the app and the assistant always have some. With
  more areas than the budget covers, every area waits a little longer instead
  of some never refreshing.
- **Firing never waits for the network**: an automation reads the stored
  forecast only (Redis, inside its transaction).

### Scale (7–8k accounts)

Rounds cost one call per area, whatever the number of homes in it. With the
default limit, rounds have 6,400 calls a day: about 130 areas refreshed every
30 minutes, and up to about 800 areas still usable (refreshed at least every
3 hours). Homes picked by province fall into 34 areas; homes in cities share
areas. Beyond that, raise the limit on a self-hosted Open-Meteo. Database work
per round is one query on the partial index `idx_automations_weather`; Redis
reads are batched (500 per MGET).

## Conditions

Stored next to device conditions in `automations.conditions`:
`{"kind": "weather", "weather": "rain_next_12h", "operator": "eq", "value": false}`.

| Id | Meaning | Values |
|---|---|---|
| `rain_now` | it rains now | true/false |
| `rain_next_1h`, `_3h`, `_6h`, `_12h` | an hour with rain in the next N hours (or rain now) | true/false |
| `temperature` | °C now | `gt`/`lt`, −10…50 |
| `temperature_max_today` | highest hourly °C of today (Vietnam day) | `gt`/`lt`, −10…50 |

An hour **has rain** when the rain chance is at least 50% or the forecast
precipitation at least 0.5 mm; it **rains now** when precipitation is at least
0.1 mm or the weather code is rain, drizzle, showers or a storm.

Saving checks the condition (`AUTOMATION_CONDITION_INVALID`), that the account
has a home (`WEATHER_LOCATION_REQUIRED`) and that the server has weather
(`WEATHER_UNAVAILABLE`). `GET /automations/options` returns
`weather: {place, conditions}` (null when weather is off, `place` null without
a home). Views of a weather condition have `kind: "weather"` and
`available: false` while the account has no home.

Suggestions once a home is set: `weather_water` (6:00, water the garden 10
minutes unless rain is forecast in 12 hours) and `weather_roof` (17:00, close
the roof and notify if rain is forecast in 6 hours).

## The assistant

`look_up_weather` (`when`: `now`, `today`, `tomorrow`, `day_after`,
`next_hours` with `amount` 1–24; `from_hour`/`to_hour` for part of a day; at
most 2 per message). The Gateway checks it, reads the forecast and writes
facts (place, period, highest/lowest °C, sky, rain hours, highest rain
chance; or `no_location`, `unavailable`). The answer is written by the same
second model call as history answers and must only use numbers from the facts,
else the server's own sentence is sent. Without a home the assistant points to
Cá nhân → Vị trí nhà & thời tiết; with weather off, the home data has no
`weather` key and it says it cannot see the weather. The place is not stored
in `assistant_turns`.

For drafts the home data lists "Thời tiết ở <place>" with the seven conditions
as watches usable only in "nếu". The prompt test set has weather cases
(`test/assistant/cases.json`: forecasts to read, drafts with weather
conditions, other cities and next week refused).

## Mock weather

With `WEATHER_MODE=mock` the Gateway plays, for each home, the weather set for
its nearest province, else for "Mọi nơi", else a sunny day. Set in the Admin
Console → Simulator → **Thời tiết giả lập** (`simulator.view` to see,
`simulator.manage` to change; each change is logged as `weather.mock_set` /
`weather.mock_cleared`):

| Scenario | Weather from the moment it is set |
|---|---|
| `sunny` (Nắng) | no rain for 3 days, 31°C now |
| `rain_soon` (Sắp mưa) | rain after `rain_in_hours` (1–12, default 2) for 4 hours, 28°C |
| `raining` (Đang mưa) | rain now for 4 hours, 25°C |
| `heat` (Nắng nóng) | no rain, 37°C, hottest about 14:00 |

`temperature` overrides the scenario's temperature now. In other modes the
Console only shows the mode (`409 WEATHER_NOT_MOCK` on changes). Tests run in
mock mode.

## API

| Method | Path | |
|---|---|---|
| GET | `/weather` | `enabled`, `mode`, `location`, `weather` (now, today, rain in hours, next 12 hours), `attribution` |
| GET | `/weather/provinces` | the 34 provinces and cities |
| GET | `/weather/places?q=` | places in Vietnam by name |
| PUT / DELETE | `/me/home-location` | set / clear the home |
| GET | `/admin/weather` | mode, provinces, mocks (`simulator.view`) |
| PUT | `/admin/weather/mock` | `{area, scenario, temperature?, rain_in_hours?}` (`simulator.manage`) |
| DELETE | `/admin/weather/mock/:area` | clear one area (`simulator.manage`) |

## Settings

| Variable | Default | |
|---|---|---|
| `WEATHER_MODE` | `live` | `live` (Open-Meteo), `mock` (Console), `off` |
| `WEATHER_API_URL` | `https://api.open-meteo.com/v1` | forecasts |
| `WEATHER_GEOCODING_URL` | `https://geocoding-api.open-meteo.com/v1` | place search |
| `WEATHER_REFRESH_MINUTES` | 30 | refresh interval (10–180) |
| `WEATHER_DAILY_CALL_LIMIT` | 8000 | most Open-Meteo calls a day |

## App

- Cá nhân → Nhà → **Vị trí nhà & thời tiết**: the current home with its
  forecast (now, today, the next hours), a province list, a ward/commune
  search, "Xóa", the rain rule and the attribution.
- Tổng quan: one line with the weather, or an invitation to set the home.
- Automation editor: "Thời tiết" first in the condition picker; without a
  home, a row that opens the location page.

## Tests

`api-gateway/test/weather.test.ts`: forecast rules (fresh, old, aged "now",
unknown), mock scenarios, the Open-Meteo parse, provinces and areas, the
assistant's lookups, facts, number check and fallback, the planner and the
home data; through the API: the home location, automations with weather
conditions saved and fired (met, not met, `weather_unavailable`), weather
suggestions, the Console's mock pages and permissions, live mode against a
local stand-in (one request per area, kept, paced rounds, daily limit), and
the assistant answering and drafting. App: `test/weather_models_test.dart`.
