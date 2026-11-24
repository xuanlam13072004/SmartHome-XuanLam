import type { FastifyInstance } from 'fastify';
import { env } from '../../config/env';
import { httpError } from '../../utils/httpError';
import { fold } from '../assistant/text';
import {
    isFresh,
    type MockWeather,
    mockSnapshot,
    snapshotFromOpenMeteo,
    type WeatherSnapshot,
} from './forecast';
import { findProvince, nearestProvince, PROVINCES, type Province } from './provinces';

/**
 * Weather (docs/architecture/weather.md). The account's home location is
 * coarse on purpose (a province, or a searched ward/commune, rounded to about
 * 1 km; never GPS). Forecasts are kept per area of 0.1° (about 11 km), so
 * neighbours share one. Areas of homes with a weather automation are
 * refreshed in rounds every WEATHER_REFRESH_MINUTES; the app and the
 * assistant fetch an area when they find its forecast old. At most
 * WEATHER_DAILY_CALL_LIMIT Open-Meteo calls a day, of which the rounds use up
 * to ROUND_SHARE. Automations only read what is stored: firing never waits
 * for the network.
 */

export interface HomeLocation {
    latitude: number;
    longitude: number;
    place: string;
}

const CELL_PREFIX = 'weather:cell:';
const CELL_TTL_SECONDS = 6 * 3600;
const BATCH = 50;
const MOCK_PREFIX = 'weather:mock:';
const DAY_MS = 24 * 3_600_000;
/** Share of the daily call limit the refresh rounds may use; the rest is for the app and the assistant. */
const ROUND_SHARE = 0.8;

/** Vietnam, its islands included: a home outside is a typo. */
const BOUNDS = { latitude: [6, 24], longitude: [102, 118] } as const;

type WithStores = Pick<FastifyInstance, 'pg' | 'redis' | 'log'>;

export const weatherEnabled = () => env.WEATHER_MODE !== 'off';

/** The 0.1° area of a location ("21.0,105.9"). */
export function cellOf(latitude: number, longitude: number): string {
    return `${(Math.round(latitude * 10) / 10).toFixed(1)},${(Math.round(longitude * 10) / 10).toFixed(1)}`;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

// ── Home location ─────────────────────────────────────────────────────────

export async function homeLocation(app: Pick<FastifyInstance, 'pg'>, accountId: string): Promise<HomeLocation | null> {
    const row = (await app.pg.query(
        'SELECT home_latitude, home_longitude, home_place FROM account_preferences WHERE account_id = $1',
        [accountId],
    )).rows[0];
    return row?.home_latitude === null || row?.home_latitude === undefined ? null
        : { latitude: Number(row.home_latitude), longitude: Number(row.home_longitude), place: row.home_place };
}

export type LocationInput = { province: string } | { place: { name: string; latitude: number; longitude: number } };

export async function setHomeLocation(app: WithStores, accountId: string, input: LocationInput): Promise<HomeLocation> {
    let location: HomeLocation;
    if ('province' in input) {
        const province = findProvince(input.province);
        if (!province) throw httpError(400, 'WEATHER_PROVINCE_UNKNOWN', 'Unknown province');
        location = { latitude: province.latitude, longitude: province.longitude, place: province.name };
    } else {
        const { latitude, longitude } = input.place;
        if (latitude < BOUNDS.latitude[0] || latitude > BOUNDS.latitude[1]
            || longitude < BOUNDS.longitude[0] || longitude > BOUNDS.longitude[1]) {
            throw httpError(400, 'WEATHER_LOCATION_OUTSIDE', 'The home must be in Vietnam');
        }
        location = { latitude: round2(latitude), longitude: round2(longitude), place: input.place.name };
    }
    await app.pg.query(
        `INSERT INTO account_preferences (account_id, home_latitude, home_longitude, home_place)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (account_id) DO UPDATE
         SET home_latitude = EXCLUDED.home_latitude, home_longitude = EXCLUDED.home_longitude,
             home_place = EXCLUDED.home_place, updated_at = NOW()`,
        [accountId, location.latitude, location.longitude, location.place],
    );
    void wantForecast(app, location);
    return location;
}

export async function clearHomeLocation(app: Pick<FastifyInstance, 'pg'>, accountId: string) {
    await app.pg.query(
        `UPDATE account_preferences SET home_latitude = NULL, home_longitude = NULL, home_place = NULL, updated_at = NOW()
         WHERE account_id = $1`,
        [accountId],
    );
}

// ── Mock weather (WEATHER_MODE=mock, set in the Admin Console) ─────────────

/** 'all' or a province code → its mock (null: none set there). */
export async function listMocks(app: Pick<FastifyInstance, 'redis'>): Promise<Record<string, MockWeather>> {
    const keys = ['all', ...PROVINCES.map(province => province.code)];
    const values = await app.redis.mget(keys.map(key => `${MOCK_PREFIX}${key}`));
    const mocks: Record<string, MockWeather> = {};
    keys.forEach((key, index) => {
        if (values[index]) mocks[key] = JSON.parse(values[index]!);
    });
    return mocks;
}

export async function setMock(app: Pick<FastifyInstance, 'redis'>, area: string, mock: MockWeather | null) {
    if (area !== 'all' && !findProvince(area)) throw httpError(400, 'WEATHER_PROVINCE_UNKNOWN', 'Unknown province');
    if (mock) await app.redis.set(`${MOCK_PREFIX}${area}`, JSON.stringify(mock));
    else await app.redis.del(`${MOCK_PREFIX}${area}`);
}

/** The mock of the province nearest to the home, else the one for every area, else a sunny day. */
async function mockFor(app: Pick<FastifyInstance, 'redis'>, location: HomeLocation): Promise<{ mock: MockWeather; area: Province }> {
    const area = nearestProvince(location.latitude, location.longitude);
    const [own, all] = await app.redis.mget(`${MOCK_PREFIX}${area.code}`, `${MOCK_PREFIX}all`);
    const raw = own ?? all;
    return { mock: raw ? JSON.parse(raw) : { scenario: 'sunny' }, area };
}

// ── Forecasts ─────────────────────────────────────────────────────────────

async function storedForecast(app: Pick<FastifyInstance, 'redis'>, cell: string): Promise<WeatherSnapshot | null> {
    const raw = await app.redis.get(`${CELL_PREFIX}${cell}`);
    return raw ? JSON.parse(raw) as WeatherSnapshot : null;
}

/**
 * The forecast of the home as stored (live) or as set (mock); null without
 * one. Only Redis is read: safe inside a transaction (automation firing).
 */
export async function readForecast(app: Pick<FastifyInstance, 'redis'>, location: HomeLocation | null, now = new Date()):
    Promise<WeatherSnapshot | null> {
    if (!location || env.WEATHER_MODE === 'off') return null;
    if (env.WEATHER_MODE === 'mock') return mockSnapshot((await mockFor(app, location)).mock, now);
    return storedForecast(app, cellOf(location.latitude, location.longitude));
}

/** Today's call counter (Vietnam day). Open-Meteo counts each location of a request as a call. */
const callsKey = () => `weather:calls:${new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10)}`;

/** Counts [calls] towards today's limit; false (and not counted) when it would go over. */
async function spend(app: Pick<FastifyInstance, 'redis'>, calls: number): Promise<boolean> {
    const key = callsKey();
    const used = await app.redis.incrby(key, calls);
    if (used === calls) await app.redis.expire(key, 2 * 24 * 3600);
    if (used <= env.WEATHER_DAILY_CALL_LIMIT) return true;
    await app.redis.decrby(key, calls);
    return false;
}

async function getJson(url: string): Promise<any> {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
}

/** Fetches the forecasts of [cells] from Open-Meteo (several per request) and stores them. */
export async function fetchCells(app: WithStores, cells: string[]): Promise<number> {
    if (env.WEATHER_MODE !== 'live' || cells.length === 0) return 0;
    let stored = 0;
    for (let index = 0; index < cells.length; index += BATCH) {
        const batch = cells.slice(index, index + BATCH);
        if (!(await spend(app, batch.length))) {
            app.log.warn({ cells: batch.length }, 'Daily weather call limit reached; forecasts are not refreshed');
            break;
        }
        const coordinates = batch.map(cell => cell.split(','));
        const query = new URLSearchParams({
            latitude: coordinates.map(item => item[0]).join(','),
            longitude: coordinates.map(item => item[1]).join(','),
            current: 'temperature_2m,precipitation,weather_code',
            hourly: 'temperature_2m,precipitation_probability,precipitation,weather_code',
            timezone: 'Asia/Bangkok',
            forecast_days: '3',
        });
        try {
            const body = await getJson(`${env.WEATHER_API_URL}/forecast?${query}`);
            const answers = Array.isArray(body) ? body : [body];
            const now = new Date();
            const write = app.redis.multi();
            batch.forEach((cell, at) => {
                const snapshot = snapshotFromOpenMeteo(answers[at], now);
                if (!snapshot) return;
                write.set(`${CELL_PREFIX}${cell}`, JSON.stringify(snapshot), 'EX', CELL_TTL_SECONDS);
                stored += 1;
            });
            await write.exec();
        } catch (error) {
            app.log.warn({ error: String(error), cells: batch.length }, 'Weather forecast request failed');
        }
    }
    return stored;
}

/** Someone needs the forecast of this home now: fetch its area when the stored one is old. */
async function wantForecast(app: WithStores, location: HomeLocation): Promise<void> {
    if (env.WEATHER_MODE !== 'live') return;
    const cell = cellOf(location.latitude, location.longitude);
    try {
        const stored = await storedForecast(app, cell);
        const old = !stored || Date.now() - Date.parse(stored.fetched_at) > env.WEATHER_REFRESH_MINUTES * 60_000;
        // One request per area at a time, however many people open the app.
        if (old && await app.redis.set(`weather:fetching:${cell}`, '1', 'EX', 20, 'NX')) await fetchCells(app, [cell]);
    } catch (error) {
        app.log.warn({ error: String(error) }, 'Could not refresh a forecast');
    }
}

/** The account's home and its forecast for the app (refreshed first when old). */
export async function weatherForAccount(app: WithStores, accountId: string) {
    const location = await homeLocation(app, accountId);
    if (location) await wantForecast(app, location);
    const snapshot = await readForecast(app, location);
    return { location, snapshot: isFresh(snapshot, new Date()) ? snapshot : null };
}

/** Also called when an automation with a weather condition is saved, so it has a forecast to read. */
export async function ensureForecast(app: WithStores, accountId: string): Promise<void> {
    const location = await homeLocation(app, accountId);
    if (location) await wantForecast(app, location);
}

/**
 * One refresh round (workers/weatherRefresher.ts): areas of homes with an
 * enabled weather automation whose forecast is older than the refresh
 * interval, oldest first. One Gateway does the round (a Redis lock), in
 * requests of up to 50 areas, and spends at most the share of today's limit
 * left spread over the rounds left: with more areas than the limit covers,
 * every area waits a little longer instead of some never being refreshed.
 */
export async function refreshForecasts(app: WithStores): Promise<number> {
    if (env.WEATHER_MODE !== 'live') return 0;
    const interval = env.WEATHER_REFRESH_MINUTES * 60_000;
    if (!(await app.redis.set('weather:refresh', '1', 'EX', Math.max(60, interval / 1000 - 60), 'NX'))) return 0;
    const homes = await app.pg.query(
        `SELECT DISTINCT round(preference.home_latitude::numeric, 1)::float8 AS latitude,
                round(preference.home_longitude::numeric, 1)::float8 AS longitude
         FROM account_preferences AS preference
         WHERE preference.home_latitude IS NOT NULL
           AND EXISTS (SELECT 1 FROM automations AS automation
                       WHERE automation.account_id = preference.account_id AND automation.enabled
                         AND automation.conditions @> '[{"kind": "weather"}]')`,
    );
    const cells = [...new Set<string>(homes.rows.map(row => cellOf(row.latitude, row.longitude)))];
    const now = Date.now();
    const due: Array<{ cell: string; fetchedAt: number }> = [];
    for (let index = 0; index < cells.length; index += 500) {
        const chunk = cells.slice(index, index + 500);
        const stored = await app.redis.mget(chunk.map(cell => `${CELL_PREFIX}${cell}`));
        chunk.forEach((cell, at) => {
            const raw = stored[at];
            const fetchedAt = raw ? Date.parse((JSON.parse(raw) as WeatherSnapshot).fetched_at) : 0;
            if (now - fetchedAt > interval - 120_000) due.push({ cell, fetchedAt });
        });
    }
    due.sort((a, b) => a.fetchedAt - b.fetchedAt);
    const used = Number(await app.redis.get(callsKey())) || 0;
    const left = Math.floor(env.WEATHER_DAILY_CALL_LIMIT * ROUND_SHARE) - used;
    const roundsLeft = Math.max(1, Math.ceil((DAY_MS - ((now + 7 * 3_600_000) % DAY_MS)) / interval));
    const budget = left <= 0 ? 0 : Math.min(left, Math.max(BATCH, Math.floor(left / roundsLeft)));
    return fetchCells(app, due.slice(0, budget).map(item => item.cell));
}

// ── Finding a place ───────────────────────────────────────────────────────

export interface PlaceResult {
    name: string;
    detail: string | null;
    latitude: number;
    longitude: number;
}

/**
 * Places in Vietnam matching [query] (wards, communes, districts, towns),
 * from Open-Meteo's geocoding (kept a day); in mock mode, the provinces.
 */
export async function searchPlaces(app: WithStores, query: string): Promise<PlaceResult[]> {
    const wanted = fold(query).trim();
    const provinces = PROVINCES
        .filter(province => fold(province.name).includes(wanted))
        .map(province => ({ name: province.name, detail: 'Tỉnh/thành phố', latitude: province.latitude, longitude: province.longitude }));
    if (env.WEATHER_MODE !== 'live') return provinces.slice(0, 8);
    const key = `weather:places:${wanted}`;
    const cached = await app.redis.get(key);
    if (cached) return JSON.parse(cached);
    if (!(await spend(app, 1))) return provinces.slice(0, 8);
    try {
        const query_ = new URLSearchParams({ name: query.trim(), count: '8', language: 'vi', countryCode: 'VN', format: 'json' });
        const body = await getJson(`${env.WEATHER_GEOCODING_URL}/search?${query_}`);
        const places: PlaceResult[] = (Array.isArray(body?.results) ? body.results : [])
            .filter((item: any) => item?.country_code === 'VN' && Number.isFinite(item.latitude) && Number.isFinite(item.longitude))
            .map((item: any) => ({
                name: String(item.name).slice(0, 80),
                detail: [item.admin2, item.admin1].filter(Boolean).join(', ').slice(0, 100) || null,
                latitude: round2(item.latitude),
                longitude: round2(item.longitude),
            }));
        await app.redis.set(key, JSON.stringify(places), 'EX', 24 * 3600);
        return places;
    } catch (error) {
        app.log.warn({ error: String(error) }, 'Place search failed');
        return provinces.slice(0, 8);
    }
}
