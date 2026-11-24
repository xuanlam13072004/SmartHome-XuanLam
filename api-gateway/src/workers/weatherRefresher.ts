import type { FastifyInstance } from 'fastify';
import { env } from '../config/env';
import { refreshForecasts } from '../modules/weather/service';

const TICK_MS = 60_000;

/**
 * Keeps the forecasts in use fresh (docs/architecture/weather.md): every
 * minute it asks whether a round is due; one Gateway takes the round (Redis
 * lock for the refresh interval) and refreshes the areas whose forecast is old.
 */
export class WeatherRefresher {
    private timer: NodeJS.Timeout | null = null;
    private busy = false;

    constructor(private readonly app: FastifyInstance) {}

    start() {
        if (env.WEATHER_MODE !== 'live') return;
        this.timer = setInterval(() => void this.tick(), TICK_MS);
        this.timer.unref();
        void this.tick();
    }

    async stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        while (this.busy) await new Promise(resolve => setTimeout(resolve, 50));
    }

    private async tick() {
        if (this.busy) return;
        this.busy = true;
        try {
            const refreshed = await refreshForecasts(this.app);
            if (refreshed > 0) this.app.log.info({ refreshed }, 'Weather forecasts refreshed');
        } catch (error) {
            this.app.log.error({ error }, 'Weather refresh failed');
        } finally {
            this.busy = false;
        }
    }
}
