import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { env } from '../../config/env';
import { typedRouteConfig } from '../../plugins/validation';
import { hasRecentReauthentication } from '../auth/reauth';
import { getRun, listRuns, startRun } from './runs';
import { createSchedule, deleteSchedule, updateSchedule } from './schedules';
import {
    createScheduleSchema,
    createSceneSchema,
    listRunsSchema,
    scheduleParamsSchema,
    updateScheduleSchema,
    reorderScenesSchema,
    runParamsSchema,
    sceneParamsSchema,
    type SceneStepInput,
    updateSceneSchema,
} from './schemas';
import {
    createScene,
    deleteScene,
    listSceneActions,
    listScenes,
    reorderScenes,
    updateScene,
} from './service';

const accountIdOf = (request: FastifyRequest) => (request.user as { userId: string }).userId;
const writes = { max: 60, timeWindow: '1 minute' };

/**
 * Scenes ("Kịch bản"): personal lists of device operations run in order by the
 * Gateway. GET /scenes/actions is the only source of what a step may do.
 * Progress of a run is pushed as the account event `scene_run_updated`.
 */
const sceneRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
    app.get('/scenes', {
        preHandler: [app.authenticate],
    }, async (request) => ({
        success: true,
        scenes: await listScenes(app, accountIdOf(request)),
        limits: {
            max_scenes: env.MAX_SCENES_PER_ACCOUNT,
            max_steps: env.MAX_SCENE_STEPS,
            max_schedules: env.MAX_SCHEDULES_PER_SCENE,
        },
    }));

    app.get('/scenes/actions', {
        preHandler: [app.authenticate],
    }, async (request) => ({
        success: true,
        devices: await listSceneActions(app, accountIdOf(request)),
    }));

    app.post('/scenes', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({ zodSchema: createSceneSchema, rateLimit: writes }),
    }, async (request) => ({
        success: true,
        scene: await createScene(
            app,
            accountIdOf(request),
            request.body as { name: string; icon: string; steps: SceneStepInput[] },
        ),
    }));

    app.put('/scenes/order', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({ zodSchema: reorderScenesSchema, rateLimit: writes }),
    }, async (request) => {
        await reorderScenes(app, accountIdOf(request), (request.body as { scene_ids: string[] }).scene_ids);
        return { success: true };
    });

    app.patch('/scenes/:sceneId', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({ zodSchema: updateSceneSchema, rateLimit: writes }),
    }, async (request) => ({
        success: true,
        scene: await updateScene(
            app,
            accountIdOf(request),
            (request.params as { sceneId: string }).sceneId,
            request.body as { name?: string; icon?: string; steps?: SceneStepInput[] },
        ),
    }));

    app.delete('/scenes/:sceneId', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({ zodSchema: sceneParamsSchema, rateLimit: writes }),
    }, async (request) => {
        await deleteScene(app, accountIdOf(request), (request.params as { sceneId: string }).sceneId);
        return { success: true };
    });

    app.post('/scenes/:sceneId/run', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({ zodSchema: sceneParamsSchema, rateLimit: { max: 30, timeWindow: '1 minute' } }),
    }, async (request) => ({
        success: true,
        run: await startRun(app, accountIdOf(request), (request.params as { sceneId: string }).sceneId, {
            reauthenticated: hasRecentReauthentication(app, request),
        }),
    }));

    // ── Schedules ("Hẹn giờ") ──────────────────────────────────────────────
    app.post('/scenes/:sceneId/schedules', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({ zodSchema: createScheduleSchema, rateLimit: writes }),
    }, async (request) => ({
        success: true,
        schedule: await createSchedule(
            app,
            accountIdOf(request),
            (request.params as { sceneId: string }).sceneId,
            request.body as { time: string; days: number[]; timezone: string },
        ),
    }));

    app.patch('/scene-schedules/:scheduleId', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({ zodSchema: updateScheduleSchema, rateLimit: writes }),
    }, async (request) => ({
        success: true,
        schedule: await updateSchedule(
            app,
            accountIdOf(request),
            (request.params as { scheduleId: string }).scheduleId,
            request.body as { time?: string; days?: number[]; timezone?: string; enabled?: boolean },
        ),
    }));

    app.delete('/scene-schedules/:scheduleId', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({ zodSchema: scheduleParamsSchema, rateLimit: writes }),
    }, async (request) => {
        await deleteSchedule(app, accountIdOf(request), (request.params as { scheduleId: string }).scheduleId);
        return { success: true };
    });

    app.get('/scene-runs', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({ zodSchema: listRunsSchema }),
    }, async (request) => {
        const query = request.query as { scene_id?: string; before?: string; limit: number };
        return {
            success: true,
            ...(await listRuns(app, accountIdOf(request), {
                sceneId: query.scene_id,
                before: query.before,
                limit: query.limit,
            })),
        };
    });

    app.get('/scene-runs/:runId', {
        preHandler: [app.authenticate],
        config: typedRouteConfig({ zodSchema: runParamsSchema }),
    }, async (request) => ({
        success: true,
        run: await getRun(app, accountIdOf(request), (request.params as { runId: string }).runId),
    }));
};

export default sceneRoutes;
