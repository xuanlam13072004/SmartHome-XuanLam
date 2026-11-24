/**
 * The forecast of one area and what automations and the assistant read from
 * it (pure: no network, no database). Live forecasts come from Open-Meteo
 * (service.ts); mock ones (WEATHER_MODE=mock, set in the Admin Console) are
 * built here from a scenario, so demos and tests need no Internet.
 */

/** Vietnam time: a fixed UTC+7, as everywhere else in the Gateway. */
const OFFSET_MS = 7 * 3_600_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** A live forecast older than this is not trusted (conditions become unknown). */
export const STALE_AFTER_MS = 3 * HOUR_MS;

/** An hour "has rain" from this chance or this amount on (shown in the app as the rule). */
export const RAIN_CHANCE = 50;
export const RAIN_MM = 0.5;

/** WMO weather codes of drizzle, rain, showers and thunderstorms. */
const RAIN_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);

export interface WeatherHour {
    /** Start of the hour (UTC ISO). */
    at: string;
    temperature: number | null;
    precipitation_probability: number | null;
    precipitation: number | null;
    weather_code: number | null;
}

export interface WeatherSnapshot {
    source: 'open-meteo' | 'mock';
    fetched_at: string;
    current: { temperature: number | null; precipitation: number | null; weather_code: number | null };
    hours: WeatherHour[];
}

// ── Conditions ("Nếu thời tiết") ──────────────────────────────────────────

export const WEATHER_CONDITIONS = [
    { id: 'rain_now', label: 'Trời đang mưa', kind: 'boolean' },
    { id: 'rain_next_1h', label: 'Có mưa trong 1 giờ tới', kind: 'boolean', hours: 1 },
    { id: 'rain_next_3h', label: 'Có mưa trong 3 giờ tới', kind: 'boolean', hours: 3 },
    { id: 'rain_next_6h', label: 'Có mưa trong 6 giờ tới', kind: 'boolean', hours: 6 },
    { id: 'rain_next_12h', label: 'Có mưa trong 12 giờ tới', kind: 'boolean', hours: 12 },
    { id: 'temperature', label: 'Nhiệt độ ngoài trời', kind: 'number' },
    { id: 'temperature_max_today', label: 'Nhiệt độ cao nhất hôm nay', kind: 'number' },
] as const;

export type WeatherConditionId = typeof WEATHER_CONDITIONS[number]['id'];
export const WEATHER_CONDITION_IDS = WEATHER_CONDITIONS.map(item => item.id) as WeatherConditionId[];
export const TEMPERATURE_RANGE = { minimum: -10, maximum: 50 } as const;

export function findWeatherCondition(id: string) {
    return WEATHER_CONDITIONS.find(item => item.id === id) ?? null;
}

/** How the pickers offer a weather condition: like a device state (`weather.<id>`, instance "Thời tiết"). */
export function weatherConditionOptions() {
    return WEATHER_CONDITIONS.map(item => ({
        property: `weather.${item.id}`,
        instance_id: 'weather',
        instance_label: 'Thời tiết',
        label: item.label,
        kind: item.kind,
        operators: item.kind === 'boolean' ? ['eq'] : ['gt', 'lt'],
        ...(item.kind === 'number' ? { unit: 'celsius', ...TEMPERATURE_RANGE } : {}),
    }));
}

/** Whether `<condition> <operator> <value>` makes sense (booleans: is; temperatures: above / below). */
export function validWeatherComparison(id: string, operator: string, value: unknown): boolean {
    const condition = findWeatherCondition(id);
    if (!condition) return false;
    if (condition.kind === 'boolean') return operator === 'eq' && typeof value === 'boolean';
    return (operator === 'gt' || operator === 'lt') && typeof value === 'number' && Number.isFinite(value)
        && value >= TEMPERATURE_RANGE.minimum && value <= TEMPERATURE_RANGE.maximum;
}

/** "Không mưa trong 12 giờ tới", "Nhiệt độ ngoài trời trên 35°C" (the app words it the same way). */
export function weatherConditionText(id: string, operator: string, value: unknown): string {
    const condition = findWeatherCondition(id);
    if (!condition) return id;
    if (condition.kind === 'number') return `${condition.label} ${operator === 'gt' ? 'trên' : 'dưới'} ${value}°C`;
    if (value === true) return condition.label;
    return condition.id === 'rain_now' ? 'Trời không mưa' : condition.label.replace(/^Có mưa/, 'Không mưa');
}

export function isFresh(snapshot: WeatherSnapshot | null, now: Date): snapshot is WeatherSnapshot {
    if (!snapshot) return false;
    return snapshot.source === 'mock' || now.getTime() - Date.parse(snapshot.fetched_at) <= STALE_AFTER_MS;
}

export const hourHasRain = (hour: WeatherHour) =>
    (hour.precipitation_probability ?? 0) >= RAIN_CHANCE || (hour.precipitation ?? 0) >= RAIN_MM;

/** How long the "current" block of a forecast stands for now; later, the forecast of this hour does. */
const CURRENT_FOR_MS = 3_600_000;

/** The weather now: the forecast's "current" block while recent, else its hour that holds [now]. */
export function currentOf(snapshot: WeatherSnapshot, now: Date): WeatherSnapshot['current'] {
    if (now.getTime() - Date.parse(snapshot.fetched_at) <= CURRENT_FOR_MS) return snapshot.current;
    const hour = snapshot.hours.find(item => {
        const start = Date.parse(item.at);
        return start <= now.getTime() && now.getTime() < start + HOUR_MS;
    });
    return hour
        ? { temperature: hour.temperature, precipitation: hour.precipitation, weather_code: hour.weather_code }
        : snapshot.current;
}

export function rainingNow(snapshot: WeatherSnapshot, now: Date): boolean | null {
    const { precipitation, weather_code: code } = currentOf(snapshot, now);
    if (precipitation === null && code === null) return null;
    return (precipitation ?? 0) >= 0.1 || (code !== null && RAIN_CODES.has(code));
}

/** Hours that overlap [from, to). */
function hoursBetween(snapshot: WeatherSnapshot, from: number, to: number): WeatherHour[] {
    return snapshot.hours.filter(hour => {
        const start = Date.parse(hour.at);
        return start + HOUR_MS > from && start < to;
    });
}

const localDay = (time: number) => Math.floor((time + OFFSET_MS) / DAY_MS);

/** Highest and lowest temperature of a Vietnam day ([offset] days from today). */
export function dayRange(snapshot: WeatherSnapshot, now: Date, offset = 0): { max: number; min: number } | null {
    const day = localDay(now.getTime()) + offset;
    const temperatures = snapshot.hours
        .filter(hour => localDay(Date.parse(hour.at)) === day && typeof hour.temperature === 'number')
        .map(hour => hour.temperature as number);
    if (temperatures.length === 0) return null;
    return { max: Math.max(...temperatures), min: Math.min(...temperatures) };
}

/** The value of a weather condition now; undefined when not known (no forecast, too old, missing data). */
export function weatherValue(snapshot: WeatherSnapshot | null, id: string, now: Date): boolean | number | undefined {
    if (!isFresh(snapshot, now)) return undefined;
    const condition = findWeatherCondition(id);
    if (!condition) return undefined;
    switch (condition.id) {
        case 'rain_now':
            return rainingNow(snapshot, now) ?? undefined;
        case 'temperature':
            return currentOf(snapshot, now).temperature ?? undefined;
        case 'temperature_max_today':
            return dayRange(snapshot, now)?.max;
        default: {
            const hours = hoursBetween(snapshot, now.getTime(), now.getTime() + condition.hours * HOUR_MS);
            if (hours.length === 0) return undefined;
            return hours.some(hourHasRain) || rainingNow(snapshot, now) === true;
        }
    }
}

export function compareWeather(actual: boolean | number | undefined, operator: string, expected: unknown): boolean {
    if (actual === undefined) return false;
    if (operator === 'eq') return actual === expected;
    if (typeof actual !== 'number' || typeof expected !== 'number') return false;
    return operator === 'gt' ? actual > expected : operator === 'lt' ? actual < expected : false;
}

// ── Words ─────────────────────────────────────────────────────────────────

/** A WMO weather code in words. */
export function describeCode(code: number | null): string | null {
    if (code === null) return null;
    if (code === 0) return 'Trời quang';
    if (code <= 2) return 'Ít mây';
    if (code === 3) return 'Nhiều mây';
    if (code === 45 || code === 48) return 'Sương mù';
    if (code >= 51 && code <= 57) return 'Mưa phùn';
    if (code >= 61 && code <= 67) return code >= 65 ? 'Mưa to' : 'Mưa';
    if (code >= 80 && code <= 82) return 'Mưa rào';
    if (code >= 95) return 'Dông';
    return null;
}

const round = (value: number | null, digits = 0) => (value === null ? null : Number(value.toFixed(digits)));

/** What the app shows: now, today, and the next 12 hours. */
export function weatherSummary(snapshot: WeatherSnapshot, now: Date) {
    const nowTime = now.getTime();
    const next = hoursBetween(snapshot, nowTime, nowTime + 12 * HOUR_MS);
    const firstRain = next.find(hourHasRain);
    const today = dayRange(snapshot, now);
    const current = currentOf(snapshot, now);
    const raining = rainingNow(snapshot, now) === true;
    return {
        source: snapshot.source,
        updated_at: snapshot.fetched_at,
        current: {
            temperature: round(current.temperature),
            raining,
            description: describeCode(current.weather_code),
        },
        today: today ? { max: round(today.max), min: round(today.min) } : null,
        // Hours until the first hour with rain (0 = now or this hour), null: none in 12 hours.
        rain_in_hours: raining ? 0
            : firstRain ? Math.max(0, Math.floor((Date.parse(firstRain.at) - nowTime) / HOUR_MS) + 1) : null,
        next_hours: next.map(hour => ({
            at: hour.at,
            temperature: round(hour.temperature),
            precipitation_probability: hour.precipitation_probability,
            rain: hourHasRain(hour),
        })),
    };
}

// ── Open-Meteo ────────────────────────────────────────────────────────────

/** One location of an Open-Meteo /v1/forecast answer (times in its utc_offset_seconds). */
export function snapshotFromOpenMeteo(body: any, fetchedAt: Date): WeatherSnapshot | null {
    const offset = Number(body?.utc_offset_seconds ?? 0) * 1000;
    const hourly = body?.hourly;
    if (!hourly || !Array.isArray(hourly.time)) return null;
    const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
    const at = (local: string) => new Date(Date.parse(`${local}:00Z`) - offset).toISOString();
    return {
        source: 'open-meteo',
        fetched_at: fetchedAt.toISOString(),
        current: {
            temperature: number(body.current?.temperature_2m),
            precipitation: number(body.current?.precipitation),
            weather_code: number(body.current?.weather_code),
        },
        hours: hourly.time.map((time: string, index: number) => ({
            at: at(time),
            temperature: number(hourly.temperature_2m?.[index]),
            precipitation_probability: number(hourly.precipitation_probability?.[index]),
            precipitation: number(hourly.precipitation?.[index]),
            weather_code: number(hourly.weather_code?.[index]),
        })),
    };
}

// ── Mock ──────────────────────────────────────────────────────────────────

export const MOCK_SCENARIOS = ['sunny', 'rain_soon', 'raining', 'heat'] as const;
export type MockScenario = typeof MOCK_SCENARIOS[number];

export interface MockWeather {
    scenario: MockScenario;
    /** Temperature now (°C); each scenario has its own default. */
    temperature?: number;
    /** rain_soon: hours until it rains (1–12). */
    rain_in_hours?: number;
}

const DEFAULT_TEMPERATURE: Record<MockScenario, number> = { sunny: 31, rain_soon: 28, raining: 25, heat: 37 };

/** A 3-day forecast that plays [mock] from now on (hours before now are dry). */
export function mockSnapshot(mock: MockWeather, now: Date): WeatherSnapshot {
    const temperature = mock.temperature ?? DEFAULT_TEMPERATURE[mock.scenario];
    const rainFrom = mock.scenario === 'raining' ? 0 : mock.scenario === 'rain_soon' ? (mock.rain_in_hours ?? 2) : null;
    const thisHour = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;
    const firstHour = (localDay(now.getTime()) * DAY_MS) - OFFSET_MS;
    // A gentle daily curve, warmest at 14:00 and coolest at 02:00, through [temperature] now.
    const swing = mock.scenario === 'heat' ? 3 : 2;
    const curve = (time: number) => Math.round(swing * Math.cos(((new Date(time + OFFSET_MS).getUTCHours() - 14) / 24) * 2 * Math.PI));
    const base = temperature - curve(thisHour);
    const hours: WeatherHour[] = [];
    for (let start = firstHour; start < firstHour + 3 * DAY_MS; start += HOUR_MS) {
        const ahead = Math.round((start - thisHour) / HOUR_MS);
        const raining = rainFrom !== null && ahead >= rainFrom && ahead < rainFrom + 4;
        hours.push({
            at: new Date(start).toISOString(),
            temperature: base + curve(start),
            precipitation_probability: raining ? 90 : 10,
            precipitation: raining ? 3 : 0,
            weather_code: raining ? 63 : mock.scenario === 'heat' || mock.scenario === 'sunny' ? 0 : 3,
        });
    }
    return {
        source: 'mock',
        fetched_at: now.toISOString(),
        current: {
            temperature,
            precipitation: mock.scenario === 'raining' ? 3 : 0,
            weather_code: mock.scenario === 'raining' ? 63 : mock.scenario === 'rain_soon' ? 3 : 0,
        },
        hours,
    };
}
