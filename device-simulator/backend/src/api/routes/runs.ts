import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { createRunSchema } from '../schemas/runs';
import { getMongoDb } from '../../infrastructure/mongodb/client';
import { SimulationRun } from '../../domain/simulation-run';
import crypto from 'crypto';
import { GenerationQueue } from '../../generation/queue';

const runsRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
    
    // Instantiate a singleton generation queue attached to the app instance.
    const generationQueue = new GenerationQueue(app.log);

    app.post('/api/simulation-runs', async (request, reply) => {
        // Assume admin token is checked in a hook (to be added)
        const config = request.body as any;
        
        const runId = `run-${crypto.randomUUID()}`;
        const newRun: SimulationRun = {
            id: runId,
            status: 'queued',
            config,
            progress: {
                users_requested: config.user_count,
                users_created: 0,
                devices_requested: 0,
                devices_provisioned: 0,
                devices_claimed: 0
            },
            total_errors: 0,
            cleanup_retries: 0,
            created_at: new Date(),
            updated_at: new Date()
        };

        const db = getMongoDb();
        await db.collection('simulation_runs').insertOne(newRun);

        // Start generation asynchronously
        // In reality, this could be triggered via an event emitter or message queue
        generationQueue.startRun(newRun).catch(err => {
            app.log.error({ err, runId }, 'Unhandled error in generation queue');
        });

        return { success: true, run_id: runId, status: 'queued' };
    });
};

export default runsRoutes;
