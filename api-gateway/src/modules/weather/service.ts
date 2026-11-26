import type { FastifyInstance } from 'fastify';
import { env } from '../../config/env';
import { httpError } from '../../utils/httpError';
import {
    isFresh,
    type MockWeather,
    mockSnapshot,
    snapshotFromOpenMeteo,
    type WeatherSnapshot,
} from './forecast';
import {
    type Area,
    AREAS,
    findArea,
    findProvince,
    mainAreaOf,
    nearestArea,
    placeOf,
    PROVINCES,
} from './provinces';

/**
 * Weather (docs/architecture/weather.md). A home's weather is that of one of
 * 63 fixed areas (the provinces before the 2025 merger; never GPS). Every
 * WEATHER_REFRESH_MINUTES one Gateway refreshes the forecasts of all 63 in
 * two Open-Meteo requests: the cost does not grow with the number of homes.
 * The app, the assistant and automations only read what is stored, so none of
 * them ever waits for the network or spends a call.
 */

export interface HomeLocation {
    /** The area's code ("binh_duong"). */
    area: string;
    /** Today's province ("ho_chi_minh"). */
    province: string;
    /** "Bình Dương (TP. Hồ Chí Minh)". */
    place: string;
    latitude: number;
    longitude: number;
}

const AREA_PREFIX = 'weather:area:';
const AREA_TTL_SECONDS = 6 * 3600;
/** Locations per Open-Meteo request: 63 areas → 2 requests. */
const BATCH = 50;
const MOCK_PREFIX = 'weather:mock:';
const ROUND_KEY = 'weather:refresh';
const FAILURES_KEY = 'weather:refresh:failures';
const REFRESHED_KEY = 'weather:refreshed_at';
/** After a failed round: retry in 5 minutes, then 10, 20…, never more often than this. */
const RETRY_SECONDS = 5 * 60;

type WithStores = Pick<FastifyInstance, 'pg' | 'redis' | 'log'>;

export const weatherEnabled = () => env.WEATHER_MODE !== 'off';

function locationIn(area: Area): HomeLocation {
    return { area: area.code, province: area.province, place: placeOf(area), latitude: area.latitude, longitude: area.longitude };
}

// ── Home location ─────────────────────────────────────────────────────────

/**
 * The home of an `account_preferences` row (null: none). The row keeps the
 * area's centre; a home stored before the areas existed reads as the area
 * nearest to it.
 */
export function locationOf(row: { home_latitude?: unknown; home_longitude?: unknown } | undefined): HomeLocation | null {
    if (row?.home_latitude === null || row?.home_latitude === undefined) return null;
    return locationIn(nearestArea(Number(row.home_latitude), Number(row.home_longitude)));
}

export async function homeLocation(app: Pick<FastifyInstance, 'pg'>, accountId: string): Promise<HomeLocation | null> {
    const row = (await app.pg.query(
        'SELECT home_latitude, home_longitude FROM account_preferences WHERE account_id = $1',
        [accountId],
    )).rows[0];
    return locationOf(row);
}

/** `{area}` an area, or `{province}` the area at the province's centre. */
export type LocationInput = { area: string } | { province: string };

export async function setHomeLocation(app: Pick<FastifyInstance, 'pg'>, accountId: string, input: LocationInput):
    Promise<HomeLocation> {
    let area: Area;
    if ('area' in input) {
        const found = findArea(input.area);
        if (!found) throw httpError(400, 'WEATHER_AREA_UNKNOWN', 'Unknown area');
        area = found;
    } else {
        const province = findProvince(input.province);
        if (!province) throw httpError(400, 'WEATHER_PROVINCE_UNKNOWN', 'Unknown province');
        area = mainAreaOf(province);
    }
    const location = locationIn(area);
    await app.pg.query(
        `INSERT INTO account_preferences (account_id, home_latitude, home_longitude, home_place)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (account_id) DO UPDATE
         SET home_latitude = EXCLUDED.home_latitude, home_longitude = EXCLUDED.home_longitude,
             home_place = EXCLUDED.home_place, updated_at = NOW()`,
        [accountId, location.latitude, location.longitude, location.place],
    );
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

/** The mock of the home's province, else the one for every area, else a sunny day. */
async function mockFor(app: Pick<FastifyInstance, 'redis'>, location: HomeLocation): Promise<MockWeather> {
    const [own, all] = await app.redis.mget(`${MOCK_PREFIX}${location.province}`, `${MOCK_PREFIX}all`);
    const raw = own ?? all;
    return raw ? JSON.parse(raw) : { scenario: 'sunny' };
}

// ── Forecasts ─────────────────────────────────────────────────────────────

/**
 * The forecast of the home as stored (live) or as set (mock); null without
 * one. Only Redis is read: safe inside a transaction (automation firing).
 */
export async function readForecast(app: Pick<FastifyInstance, 'redis'>, location: HomeLocation | null, now = new Date()):
    Promise<WeatherSnapshot | null> {
    if (!location || env.WEATHER_MODE === 'off') return null;
    if (env.WEATHER_MODE === 'mock') return mockSnapshot(await mockFor(app, location), now);
    const raw = await app.redis.get(`${AREA_PREFIX}${location.area}`);
    return raw ? JSON.parse(raw) as WeatherSnapshot : null;
}

/** The account's home and its forecast for the app and the assistant (null when unknown or old). */
export async function weatherForAccount(app: WithStores, accountId: string) {
    const location = await homeLocation(app, accountId);
    const snapshot = await readForecast(app, location);
    return { location, snapshot: isFresh(snapshot, new Date()) ? snapshot : null };
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

/** Fetches the forecasts of [areas] from Open-Meteo (up to 50 per request) and stores them. */
async function fetchAreas(app: WithStores, areas: readonly Area[]): Promise<{ stored: number; failed: boolean }> {
    let stored = 0;
    let failed = false;
    for (let index = 0; index < areas.length; index += BATCH) {
        const batch = areas.slice(index, index + BATCH);
        if (!(await spend(app, batch.length))) {
            app.log.warn({ areas: batch.length }, 'Daily weather call limit reached; forecasts are not refreshed');
            break;
        }
        const query = new URLSearchParams({
            latitude: batch.map(area => area.latitude).join(','),
            longitude: batch.map(area => area.longitude).join(','),
            current: 'temperature_2m,precipitation,weather_code',
            hourly: 'temperature_2m,precipitation_probability,precipitation,weather_code',
            timezone: 'Asia/Bangkok',
            forecast_days: '3',
        });
        try {
            const response = await fetch(`${env.WEATHER_API_URL}/forecast?${query}`, {
                signal: AbortSignal.timeout(10_000),
                headers: { accept: 'application/json' },
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const body = await response.json();
            const answers = Array.isArray(body) ? body : [body];
            const now = new Date();
            const write = app.redis.multi();
            let kept = 0;
            batch.forEach((area, at) => {
                const snapshot = snapshotFromOpenMeteo(answers[at], now);
                if (!snapshot) return;
                write.set(`${AREA_PREFIX}${area.code}`, JSON.stringify(snapshot), 'EX', AREA_TTL_SECONDS);
                kept += 1;
            });
            await write.exec();
            stored += kept;
            // An answer that cannot be read counts as a failure: that area is tried again sooner.
            if (kept < batch.length) failed = true;
        } catch (error) {
            failed = true;
            app.log.warn({ error: String(error), areas: batch.length }, 'Weather forecast request failed');
        }
    }
    return { stored, failed };
}

/**
 * One refresh round (workers/weatherRefresher.ts ticks every minute): one
 * Gateway takes the round (a Redis lock for the refresh interval) and fetches
 * the areas whose forecast is older than the interval. A failed round is
 * tried again sooner (5, 10, 20… minutes), never more often than the
 * interval allows, so an Open-Meteo outage costs no more calls than a day of
 * normal rounds.
 */
export async function refreshForecasts(app: WithStores): Promise<number> {
    if (env.WEATHER_MODE !== 'live') return 0;
    const intervalSeconds = env.WEATHER_REFRESH_MINUTES * 60;
    const lockSeconds = intervalSeconds - 60;
    if (!(await app.redis.set(ROUND_KEY, '1', 'EX', lockSeconds, 'NX'))) return 0;
    const raws = await app.redis.mget(AREAS.map(area => `${AREA_PREFIX}${area.code}`));
    const now = Date.now();
    const due = AREAS.filter((_, index) => {
        const raw = raws[index];
        const fetchedAt = raw ? Date.parse((JSON.parse(raw) as WeatherSnapshot).fetched_at) : 0;
        return now - fetchedAt > (intervalSeconds - 120) * 1000;
    });
    if (due.length === 0) return 0;
    const { stored, failed } = await fetchAreas(app, due);
    if (stored > 0) await app.redis.set(REFRESHED_KEY, new Date().toISOString());
    if (failed) {
        const failures = await app.redis.incr(FAILURES_KEY);
        await app.redis.expire(FAILURES_KEY, 24 * 3600);
        const retry = Math.min(lockSeconds, RETRY_SECONDS * 2 ** Math.min(failures - 1, 10));
        await app.redis.set(ROUND_KEY, '1', 'EX', retry);
    } else {
        await app.redis.del(FAILURES_KEY);
    }
    return stored;
}

/** For the Admin Console: how fresh the live forecasts are and today's calls. */
export async function weatherStatus(app: Pick<FastifyInstance, 'redis'>) {
    const [refreshedAt, calls, ...raws] = await app.redis.mget(
        REFRESHED_KEY, callsKey(), ...AREAS.map(area => `${AREA_PREFIX}${area.code}`),
    );
    const now = new Date();
    return {
        areas: AREAS.length,
        fresh_areas: raws.filter(raw => raw && isFresh(JSON.parse(raw) as WeatherSnapshot, now)).length,
        refreshed_at: refreshedAt ?? null,
        calls_today: Number(calls) || 0,
        daily_call_limit: env.WEATHER_DAILY_CALL_LIMIT,
        refresh_minutes: env.WEATHER_REFRESH_MINUTES,
    };
}
