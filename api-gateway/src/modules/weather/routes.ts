import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env';
import { typedRouteConfig } from '../../plugins/validation';
import { httpError } from '../../utils/httpError';
import { weatherSummary } from './forecast';
import { PROVINCES } from './provinces';
import { clearHomeLocation, searchPlaces, setHomeLocation, weatherEnabled, weatherForAccount } from './service';

/** "Vị trí nhà & thời tiết" (docs/architecture/weather.md). */

const ATTRIBUTION = 'Dữ liệu thời tiết: Open-Meteo.com (CC BY 4.0)';

const placeName = z.string()
    .transform(value => value.replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim())
    .pipe(z.string().min(1).max(120));

const locationSchema = z.object({
    body: z.union([
        z.object({ province: z.string().min(1).max(40) }).strict(),
        z.object({
            place: z.object({
                name: placeName,
                latitude: z.number().finite(),
                longitude: z.number().finite(),
            }).strict(),
        }).strict(),
    ]),
});

const searchSchema = z.object({
    query: z.object({ q: z.string().trim().min(2).max(60) }).strict(),
});

const accountIdOf = (request: any) => (request.user as any).userId as string;

export default async function weatherRoutes(app: FastifyInstance) {
    const assertOn = () => {
        if (!weatherEnabled()) throw httpError(503, 'WEATHER_UNAVAILABLE', 'Weather is not enabled on this server');
    };

    app.get('/weather', { preHandler: [app.authenticate] }, async (request) => {
        if (!weatherEnabled()) return { success: true, enabled: false, location: null, weather: null, attribution: null };
        const { location, snapshot } = await weatherForAccount(app, accountIdOf(request));
        return {
            success: true,
            enabled: true,
            mode: env.WEATHER_MODE,
            location,
            weather: snapshot ? weatherSummary(snapshot, new Date()) : null,
            attribution: env.WEATHER_MODE === 'live' ? ATTRIBUTION : 'Thời tiết giả lập (thử nghiệm)',
        };
    });

    app.get('/weather/provinces', { preHandler: [app.authenticate] }, async () => ({
        success: true,
        provinces: PROVINCES.map(({ code, name }) => ({ code, name })),
    }));

    app.get('/weather/places', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({ zodSchema: searchSchema, rateLimit: { max: 20, timeWindow: '1 minute' } }),
    }, async (request) => {
        assertOn();
        return { success: true, places: await searchPlaces(app, (request.query as any).q) };
    });

    app.put('/me/home-location', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({ zodSchema: locationSchema, rateLimit: { max: 20, timeWindow: '1 minute' } }),
    }, async (request) => {
        assertOn();
        return { success: true, location: await setHomeLocation(app, accountIdOf(request), request.body as any) };
    });

    app.delete('/me/home-location', { preHandler: [app.authenticate] }, async (request) => {
        await clearHomeLocation(app, accountIdOf(request));
        return { success: true };
    });
}
