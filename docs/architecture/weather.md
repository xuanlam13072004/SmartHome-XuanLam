# Weather ("Vị trí nhà & thời tiết")

The weather at the account's home, from Open-Meteo.com, for three things:

- automations with a weather condition in "Nếu" ("6:00 tưới vườn nếu 12 giờ
  tới không mưa", "17:00 đóng mái nếu 6 giờ tới có mưa");
- the assistant, which answers "chiều nay có mưa không?" from the forecast and
  can draft such automations;
- one line on "Tổng quan" and a forecast on the home location page.

Code: `api-gateway/src/modules/weather/` (provinces and areas, forecast rules,
service, routes), `src/workers/weatherRefresher.ts`, the assistant's
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
- **63 fixed areas, never GPS.** A home is in one of the 63 provinces and
  cities as they were before the 2025 merger, read at its former centre: the
  user picks today's province (34), then the area inside it. No search by
  ward or commune. The phone's location is never read. Like a weather report
  on TV: one forecast per province, the same for every viewer there.
- **The cost does not grow with users.** All 63 areas are refreshed every 30
  minutes, whether 10 or 8,000 homes use them: 63 calls a round, 3,024 a day,
  under a third of the free 10,000.
- **Open-Meteo**: free, no key, data under CC BY 4.0, so the app and the
  Console show "Dữ liệu thời tiết: Open-Meteo.com (CC BY 4.0)" with a link
  to open-meteo.com. Free limits: 10,000 calls a day, 5,000 an hour, 600 a
  minute; each location of a request counts as one call. The free API is for
  non-commercial use: a commercial deployment runs Open-Meteo itself (open
  source) or takes a paid plan, and points `WEATHER_API_URL` at it.
- **Mock weather** for demos and tests (`WEATHER_MODE=mock`), set in the Admin
  Console and logged.
- **The assistant never guesses the weather**: it reads the forecast and its
  answer goes through the same number check as history answers.

## The home location

### The 63 areas

`provinces.ts`: today's 34 provinces (`PROVINCES`, each at its
administrative centre) and the 63 areas (`AREAS`: the old province's code and
name, today's province, its former centre). 11 provinces were not merged (one
area each); the 23 merged ones have 2 or 3 areas, the one at the province's
centre first (Lào Cai is run from Yên Bái, Gia Lai from Quy Nhơn, Tây Ninh
from Tân An…). "Only the province" means that area.

| Province | Areas |
|---|---|
| Not merged | Hà Nội, Huế, Lai Châu, Điện Biên, Sơn La, Lạng Sơn, Cao Bằng, Quảng Ninh, Thanh Hóa, Nghệ An, Hà Tĩnh |
| Tuyên Quang | Tuyên Quang, Hà Giang |
| Lào Cai | Yên Bái, Lào Cai |
| Thái Nguyên | Thái Nguyên, Bắc Kạn |
| Phú Thọ | Phú Thọ, Vĩnh Phúc, Hòa Bình |
| Bắc Ninh | Bắc Giang, Bắc Ninh |
| Hưng Yên | Hưng Yên, Thái Bình |
| Hải Phòng | Hải Phòng, Hải Dương |
| Ninh Bình | Ninh Bình, Hà Nam, Nam Định |
| Quảng Trị | Quảng Bình, Quảng Trị |
| Đà Nẵng | Đà Nẵng, Quảng Nam |
| Quảng Ngãi | Quảng Ngãi, Kon Tum |
| Gia Lai | Bình Định, Gia Lai |
| Khánh Hòa | Khánh Hòa, Ninh Thuận |
| Lâm Đồng | Lâm Đồng, Đắk Nông, Bình Thuận |
| Đắk Lắk | Đắk Lắk, Phú Yên |
| TP. Hồ Chí Minh | TP. Hồ Chí Minh, Bình Dương, Bà Rịa – Vũng Tàu |
| Đồng Nai | Đồng Nai, Bình Phước |
| Tây Ninh | Long An, Tây Ninh |
| Cần Thơ | Cần Thơ, Sóc Trăng, Hậu Giang |
| Vĩnh Long | Vĩnh Long, Bến Tre, Trà Vinh |
| Đồng Tháp | Tiền Giang, Đồng Tháp |
| Cà Mau | Cà Mau, Bạc Liêu |
| An Giang | Kiên Giang, An Giang |

The home is named "Hà Nội" for an unmerged province, "Bình Dương (TP. Hồ
Chí Minh)" for an area of a merged one.

### Stored

`account_preferences.home_latitude`, `home_longitude`, `home_place` (migration
214), all three set or all empty: the area's centre and name. A home is
always read as the area nearest to the stored point, so a home saved before
the areas existed (a ward rounded to 0.01°, or a province centre) falls into
the area around it with no migration; it is rewritten the next time the user
picks an area.

`PUT /me/home-location` takes `{"area": "binh_duong"}` or `{"province":
"lao_cai"}` (the area at its centre) and returns the home: `{area, province,
place, latitude, longitude}`. An unknown code is `WEATHER_AREA_UNKNOWN` /
`WEATHER_PROVINCE_UNKNOWN`. `DELETE /me/home-location` clears it.

## Forecasts

One forecast per area in Redis:

| Redis key | What |
|---|---|
| `weather:area:<code>` | the forecast of an area (kept 6 hours) |
| `weather:refresh` | the round lock: one round per interval across Gateways |
| `weather:refresh:failures` | failed rounds in a row (for the retry wait) |
| `weather:refreshed_at` | when a round last stored forecasts (the Console) |
| `weather:calls:<YYYY-MM-DD>` | calls made today (Vietnam day) |
| `weather:mock:<province or all>` | mock weather set in the Console |

A request (`/v1/forecast`) carries up to 50 areas: the current block
(temperature, precipitation, WMO weather code) and three days of hourly
temperature, rain chance, precipitation and weather code, in UTC. The 63
areas are two requests (50 + 13).

- **"Now"** is the current block during the first hour after the request,
  then the hour of the forecast that holds now.
- **Usable for 3 hours.** Older, every condition reads as unknown.
- **Only the rounds fetch.** Every Gateway ticks every minute; one takes the
  round (Redis lock for `WEATHER_REFRESH_MINUTES` − 1 minute) and fetches the
  areas whose forecast is older than the interval (all 63 normally). The app,
  the assistant and automations only read Redis: opening the app never
  calls Open-Meteo, and **firing never waits for the network** (an automation
  reads the stored forecast inside its transaction).
- **A failed round** (no answer, an error, an answer that cannot be read) is
  tried again after 5 minutes, then 10, 20…, never later than the interval;
  a good round resets it. An outage therefore costs at most what a day of
  normal rounds costs, and three failed rounds still leave the last forecast
  usable (3 hours).
- **Daily cap.** At most `WEATHER_DAILY_CALL_LIMIT` (8,000) calls a day,
  counted before each request; a request past it is not sent and is logged.
  It is a safety net: normal rounds use 3,024.

### Scale (7–8k accounts)

| | Calls a day |
|---|---|
| 63 areas × 48 rounds (30 minutes) | 3,024 |
| Retries after failures (worst case) | ≤ 3,024 |
| Free limit | 10,000 |

The number of accounts changes nothing: 8,000 homes in TP. Hồ Chí Minh share
one forecast. Shorter intervals are allowed down to 15 minutes (6,048 a day).
Database work: none in a round; reading a home is one row and 63 distance
comparisons.

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
(`WEATHER_UNAVAILABLE`); it fetches nothing (the rounds keep every area fresh). `GET /automations/options` returns
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
the province of its area, else for "Mọi nơi", else a sunny day. Set in the Admin
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
| GET | `/weather` | `enabled`, `mode`, `location`, `weather` (now, today, rain in hours, next 12 hours), `attribution` `{text, url}` (`url` null for mock weather) |
| GET | `/weather/provinces` | the 34 provinces and cities, each with its `areas` (`{code, name}`, its centre first) |
| PUT / DELETE | `/me/home-location` | set (`{area}` or `{province}`) / clear the home |
| GET | `/admin/weather` | mode, provinces, mocks; `live` (live mode only): `areas`, `fresh_areas`, `refreshed_at`, `calls_today`, `daily_call_limit`, `refresh_minutes` (`simulator.view`) |
| PUT | `/admin/weather/mock` | `{area, scenario, temperature?, rain_in_hours?}` (`simulator.manage`) |
| DELETE | `/admin/weather/mock/:area` | clear one area (`simulator.manage`) |

## Settings

| Variable | Default | |
|---|---|---|
| `WEATHER_MODE` | `live` | `live` (Open-Meteo), `mock` (Console), `off` |
| `WEATHER_API_URL` | `https://api.open-meteo.com/v1` | forecasts |
| `WEATHER_REFRESH_MINUTES` | 30 | refresh interval (15–180); a round is 63 calls |
| `WEATHER_DAILY_CALL_LIMIT` | 8000 | most Open-Meteo calls a day (safety net) |

To use real forecasts with Docker: `WEATHER_MODE=live` in the root `.env`,
then `docker compose up -d api-gateway`. The first round runs within a
minute; the Console's "Thời tiết giả lập" page then shows 63/63 areas.

## App

- Cá nhân → Nhà → **Vị trí nhà & thời tiết**: the current home with its
  forecast (now, today, the next hours), "Chọn khu vực" (the province list,
  filtered by today's or old names; a merged province then lists its areas),
  "Xóa", the rain rule and the attribution, which opens open-meteo.com
  (`url_launcher`).
- Tổng quan: one line with the weather, or an invitation to set the home.
- Automation editor: "Thời tiết" first in the condition picker; without a
  home, a row that opens the location page.

## Tests

`api-gateway/test/weather.test.ts`: forecast rules (fresh, old, aged "now",
unknown), mock scenarios, the Open-Meteo parse, the 34 provinces and 63
areas (centres first, names, old homes read as their area), the assistant's
lookups, facts, number check and fallback, the planner and the home data;
through the API: the home location (`{area}`, `{province}`, errors, an old
ward home), automations with weather conditions saved and fired (met, not
met, `weather_unavailable`), weather suggestions, the Console's mock pages,
permissions and live status, live mode against a local stand-in (63 areas in
2 requests, read without calls, one round per interval, only old areas
fetched, retry after 5 then 10 minutes, daily limit), and the assistant
answering and drafting. App: `test/weather_models_test.dart`.
