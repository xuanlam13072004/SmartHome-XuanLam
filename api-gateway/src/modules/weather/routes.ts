import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env';
import { typedRouteConfig } from '../../plugins/validation';
import { httpError } from '../../utils/httpError';
import { weatherSummary } from './forecast';
import { areasOf, PROVINCES } from './provinces';
import { clearHomeLocation, setHomeLocation, weatherEnabled, weatherForAccount } from './service';

/** "Vị trí nhà & thời tiết" (docs/architecture/weather.md). */

/** Open-Meteo's data is CC BY 4.0: the app shows the source with a link. */
const ATTRIBUTION = { text: 'Dữ liệu thời tiết: Open-Meteo.com (CC BY 4.0)', url: 'https://open-meteo.com/' };
const MOCK_ATTRIBUTION = { text: 'Thời tiết giả lập (thử nghiệm)', url: null };

const code = z.string().regex(/^[a-z_]{2,40}$/);

const locationSchema = z.object({
    body: z.union([
        z.object({ area: code }).strict(),
        z.object({ province: code }).strict(),
    ]),
});

const accountIdOf = (request: any) => (request.user as any).userId as string;

export default async function weatherRoutes(app: FastifyInstance) {
    app.get('/weather', { preHandler: [app.authenticate] }, async (request) => {
        if (!weatherEnabled()) return { success: true, enabled: false, location: null, weather: null, attribution: null };
        const { location, snapshot } = await weatherForAccount(app, accountIdOf(request));
        return {
            success: true,
            enabled: true,
            mode: env.WEATHER_MODE,
            location,
            weather: snapshot ? weatherSummary(snapshot, new Date()) : null,
            attribution: env.WEATHER_MODE === 'live' ? ATTRIBUTION : MOCK_ATTRIBUTION,
        };
    });

    /** Today's 34 provinces, each with its areas (the provinces before 2025), its centre first. */
    app.get('/weather/provinces', { preHandler: [app.authenticate] }, async () => ({
        success: true,
        provinces: PROVINCES.map(({ code: provinceCode, name }) => ({
            code: provinceCode,
            name,
            areas: areasOf(provinceCode).map(area => ({ code: area.code, name: area.name })),
        })),
    }));

    app.put('/me/home-location', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({ zodSchema: locationSchema, rateLimit: { max: 20, timeWindow: '1 minute' } }),
    }, async (request) => {
        if (!weatherEnabled()) throw httpError(503, 'WEATHER_UNAVAILABLE', 'Weather is not enabled on this server');
        return { success: true, location: await setHomeLocation(app, accountIdOf(request), request.body as any) };
    });

    app.delete('/me/home-location', { preHandler: [app.authenticate] }, async (request) => {
        await clearHomeLocation(app, accountIdOf(request));
        return { success: true };
    });
}
