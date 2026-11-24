import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { env } from '../../config/env';
import { typedRouteConfig } from '../../plugins/validation';
import {
    applySuggestionSchema,
    automationParamsSchema,
    type AutomationInput,
    createAutomationSchema,
    replaceAutomationSchema,
    setEnabledSchema,
} from './schemas';
import {
    createAutomation,
    deleteAutomation,
    listAutomationOptions,
    listAutomations,
    weatherOptions,
    replaceAutomation,
    setAutomationEnabled,
} from './service';
import { applySuggestion, listSuggestions } from './suggestions';

const accountIdOf = (request: FastifyRequest) => (request.user as { userId: string }).userId;
const writes = { max: 60, timeWindow: '1 minute' };
const automationIdOf = (request: FastifyRequest) => (request.params as { automationId: string }).automationId;

/**
 * Automations ("Tự động"). GET /automations/options is the only source of the
 * states and events a trigger or condition may use. When one fires, the
 * account gets `automation_fired` (and `notification_created` when it notifies).
 */
const automationRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
    app.get('/automations', {
        preHandler: [app.authenticate],
    }, async (request) => ({
        success: true,
        automations: await listAutomations(app, accountIdOf(request)),
        limits: { max_automations: env.MAX_AUTOMATIONS_PER_ACCOUNT, max_conditions: 3 },
    }));

    app.get('/automations/options', {
        preHandler: [app.authenticate],
    }, async (request) => ({
        success: true,
        devices: await listAutomationOptions(app, accountIdOf(request)),
        // Weather conditions ("Nếu"): null when the server has no weather; place null = no home location yet.
        weather: await weatherOptions(app, accountIdOf(request)),
    }));

    app.get('/automations/suggestions', {
        preHandler: [app.authenticate],
    }, async (request) => ({
        success: true,
        suggestions: await listSuggestions(app, accountIdOf(request)),
    }));

    app.post('/automations/suggestions/apply', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({ zodSchema: applySuggestionSchema, rateLimit: writes }),
    }, async (request) => {
        const body = request.body as { key: string; timezone: string };
        return { success: true, ...(await applySuggestion(app, accountIdOf(request), body.key, body.timezone)) };
    });

    app.post('/automations', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({ zodSchema: createAutomationSchema, rateLimit: writes }),
    }, async (request) => ({
        success: true,
        automation: await createAutomation(app, accountIdOf(request), request.body as AutomationInput),
    }));

    app.put('/automations/:automationId', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({ zodSchema: replaceAutomationSchema, rateLimit: writes }),
    }, async (request) => ({
        success: true,
        automation: await replaceAutomation(
            app, accountIdOf(request), automationIdOf(request), request.body as AutomationInput,
        ),
    }));

    app.patch('/automations/:automationId', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({ zodSchema: setEnabledSchema, rateLimit: writes }),
    }, async (request) => ({
        success: true,
        automation: await setAutomationEnabled(
            app, accountIdOf(request), automationIdOf(request), (request.body as { enabled: boolean }).enabled,
        ),
    }));

    app.delete('/automations/:automationId', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({ zodSchema: automationParamsSchema, rateLimit: writes }),
    }, async (request) => {
        await deleteAutomation(app, accountIdOf(request), automationIdOf(request));
        return { success: true };
    });
};

export default automationRoutes;
