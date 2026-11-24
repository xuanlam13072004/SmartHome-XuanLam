import {
    dayRange,
    describeCode,
    hourHasRain,
    isFresh,
    rainingNow,
    type WeatherSnapshot,
    weatherSummary,
} from '../weather/forecast';
import { dayLabel, historyFallback, type HistoryFacts } from './history';

/**
 * Weather questions ("chiều nay có mưa không?", "mai nóng không?"): the model
 * fills look_up_weather, the server checks it here and reads the forecast of
 * the account's home, and the answer is written from those facts like a
 * history answer (same prompt, same number check). Forecasts cover today and
 * the next two days.
 */

export const WEATHER_WHENS = ['now', 'today', 'tomorrow', 'day_after', 'next_hours'] as const;
export type WeatherWhen = typeof WEATHER_WHENS[number];
export const MAX_WEATHER_LOOKUPS = 2;

const OFFSET_MS = 7 * 3_600_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface WeatherLookup {
    when: WeatherWhen;
    start: Date;
    end: Date;
    /** "bây giờ", "ngày mai (24/11), 06:00–12:00", "6 giờ tới". */
    label: string;
}

const pad = (value: number) => String(value).padStart(2, '0');
const integer = (raw: unknown) => (raw === undefined || raw === null || raw === '' ? null : Number(raw));

export function checkWeatherLookup(args: Record<string, unknown>, now: Date):
    { ok: true; lookup: WeatherLookup } | { ok: false; reason: 'bad_value' | 'missing_value' } {
    const when = String(args.when ?? '') as WeatherWhen;
    if (!WEATHER_WHENS.includes(when)) return { ok: false, reason: args.when ? 'bad_value' : 'missing_value' };
    const nowTime = now.getTime();
    if (when === 'now') return { ok: true, lookup: { when, start: now, end: now, label: 'bây giờ' } };
    if (when === 'next_hours') {
        const hours = integer(args.amount);
        if (hours === null || !Number.isInteger(hours) || hours < 1 || hours > 24) return { ok: false, reason: 'bad_value' };
        return { ok: true, lookup: { when, start: now, end: new Date(nowTime + hours * HOUR_MS), label: `${hours} giờ tới` } };
    }
    const offset = when === 'today' ? 0 : when === 'tomorrow' ? 1 : 2;
    const day = Math.floor((nowTime + OFFSET_MS) / DAY_MS) * DAY_MS - OFFSET_MS + offset * DAY_MS;
    let label = `${['hôm nay', 'ngày mai', 'ngày kia'][offset]} (${dayLabel(day)})`;
    let start = day;
    let end = day + DAY_MS;
    const fromHour = integer(args.from_hour);
    const toHour = integer(args.to_hour);
    if (fromHour !== null || toHour !== null) {
        const first = fromHour ?? 0;
        const last = toHour ?? 24;
        if (!Number.isInteger(first) || !Number.isInteger(last) || first < 0 || last > 24 || last <= first) {
            return { ok: false, reason: 'bad_value' };
        }
        start = day + first * HOUR_MS;
        end = day + last * HOUR_MS;
        label = `${label}, ${pad(first)}:00–${pad(last)}:00`;
    }
    return { ok: true, lookup: { when, start: new Date(start), end: new Date(end), label } };
}

const localHour = (iso: string) => `${pad(new Date(Date.parse(iso) + OFFSET_MS).getUTCHours())}:00`;

/** What the forecast says for [lookup], as the answer reads it. */
export function weatherFacts(lookup: WeatherLookup, snapshot: WeatherSnapshot | null, place: string | null, now: Date): HistoryFacts {
    const head: HistoryFacts = { kind: 'weather', period: lookup.label };
    if (!place) return { ...head, no_location: true };
    if (!isFresh(snapshot, now)) return { ...head, place, unavailable: true };
    if (snapshot.source === 'mock') head.mock = true;
    if (lookup.when === 'now') {
        const summary = weatherSummary(snapshot, now);
        if (summary.current.temperature === null) return { ...head, place, unavailable: true };
        return {
            ...head,
            place,
            temperature: summary.current.temperature,
            ...(summary.current.description ? { sky: summary.current.description } : {}),
            raining: rainingNow(snapshot, now) === true,
            ...(summary.rain_in_hours !== null && summary.rain_in_hours > 0 ? { rain_in_hours: summary.rain_in_hours } : {}),
        };
    }
    const hours = snapshot.hours.filter(hour => {
        const start = Date.parse(hour.at);
        return start + HOUR_MS > lookup.start.getTime() && start < lookup.end.getTime();
    });
    if (hours.length === 0) return { ...head, place, unavailable: true };
    const temperatures = hours.map(hour => hour.temperature).filter((value): value is number => value !== null);
    const chances = hours.map(hour => hour.precipitation_probability ?? 0);
    const rainy = hours.filter(hourHasRain);
    const codes = hours.map(hour => describeCode(hour.weather_code)).filter((value): value is string => Boolean(value));
    const sky = codes.length > 0
        ? [...new Set(codes)].sort((a, b) => codes.filter(code => code === b).length - codes.filter(code => code === a).length)[0]
        : null;
    const wholeDay = lookup.end.getTime() - lookup.start.getTime() === DAY_MS && lookup.when !== 'next_hours';
    const day = wholeDay ? dayRange(snapshot, now, ['today', 'tomorrow', 'day_after'].indexOf(lookup.when)) : null;
    return {
        ...head,
        place,
        ...(temperatures.length ? {
            highest: Math.round(day?.max ?? Math.max(...temperatures)),
            lowest: Math.round(day?.min ?? Math.min(...temperatures)),
        } : {}),
        ...(sky ? { sky } : {}),
        rain: rainy.length > 0,
        max_rain_chance: Math.max(...chances),
        ...(rainy.length > 0 ? { rain_hours: rainy.slice(0, 12).map(hour => localHour(hour.at)) } : {}),
    };
}

/** Weather facts when the server cannot read a forecast (weather turned off on this server). */
export const weatherOff = (lookup: WeatherLookup): HistoryFacts => ({ kind: 'weather', period: lookup.label, unavailable: true });

/** The server's sentence for a weather lookup (when the model's answer cannot be used). */
export function weatherFallback(item: HistoryFacts): string {
    if (item.no_location) {
        return 'Bạn chưa đặt vị trí nhà nên mình chưa xem được thời tiết. Hãy đặt ở Cá nhân → Vị trí nhà & thời tiết.';
    }
    if (item.unavailable) return 'Mình chưa lấy được dự báo thời tiết lúc này, bạn thử lại sau nhé.';
    if (item.temperature !== undefined) {
        return `Theo dự báo, bây giờ ở ${item.place} khoảng ${item.temperature}°C${item.sky ? `, ${String(item.sky).toLowerCase()}` : ''}`
            + `${item.raining ? ', đang có mưa' : ''}.`;
    }
    const range = item.lowest !== undefined ? `${item.lowest}–${item.highest}°C, ` : '';
    const rain = item.rain
        ? `có thể mưa khoảng ${(item.rain_hours as string[]).slice(0, 4).join(', ')} (khả năng đến ${item.max_rain_chance}%)`
        : 'không có mưa';
    return `Theo dự báo, ${item.period} ở ${item.place}: ${range}${rain}.`;
}

/** The server's sentences for history and weather facts together, in their order. */
export function answerFallback(facts: HistoryFacts[]): string {
    const lines = facts.map(item => (item.kind === 'weather' ? weatherFallback(item) : historyFallback([item])));
    return [...new Set(lines.filter(Boolean))].join(' ');
}
