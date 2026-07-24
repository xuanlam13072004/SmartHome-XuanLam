import { SimulationRun } from '../domain/simulation-run';
import { getMongoDb } from '../infrastructure/mongodb/client';
import { generateUser } from './user-generator';
import { apiGateway } from '../infrastructure/api-gateway/client';
import { provisionMockDevice } from '../provisioning/factory';
import { encrypt } from '../security/crypto';
import { getRuntimeManager } from '../runtime/manager';
import pino from 'pino';

// Simple delay function for rate limiting and backoff
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class GenerationQueue {
    private logger: pino.Logger;
    private runningTasks: Set<string> = new Set(); // runIds

    constructor(logger: pino.Logger) {
        this.logger = logger.child({ module: 'GenerationQueue' });
    }

    async startRun(run: SimulationRun) {
        if (this.runningTasks.has(run.id)) return;
        this.runningTasks.add(run.id);

        this.logger.info({ runId: run.id }, 'Started simulation run generation');

        try {
            await this.updateRunStatus(run.id, 'running');

            for (let i = run.progress.users_created; i < run.config.user_count; i++) {
                if (!this.runningTasks.has(run.id)) {
                    this.logger.info({ runId: run.id }, 'Run paused/cancelled');
                    break;
                }

                await this.processUserGeneration(run, i);
                
                await delay(2000); 
            }

            if (this.runningTasks.has(run.id)) {
                await this.updateRunStatus(run.id, 'completed');
                this.runningTasks.delete(run.id);
            }
        } catch (err: any) {
            this.logger.error({ err, runId: run.id }, 'Run failed');
            await this.recordError(run.id, err.message);
            await this.updateRunStatus(run.id, 'failed');
            this.runningTasks.delete(run.id);
        }
    }

    stopRun(runId: string) {
        this.runningTasks.delete(runId);
    }

    private async processUserGeneration(run: SimulationRun, index: number) {
        const db = getMongoDb();
        
        const userData = generateUser(index, run.id, run.config.email_domain, run.config.username_prefix);
        const registeredUser = await apiGateway.register(userData);
        const session = await apiGateway.login({ email: userData.email, password: userData.password });
        const encryptedPassword = encrypt(userData.password);
        
        await db.collection('simulated_users').insertOne({
            run_id: run.id,
            account_id: registeredUser.id,
            username: userData.username,
            email: userData.email,
            full_name: userData.full_name,
            credential: encryptedPassword,
            status: 'active',
            retention_policy: run.config.cleanup_policy === 'auto_24h' ? 'ttl' : 'permanent',
            created_at: new Date(),
        });

        await db.collection('simulation_runs').updateOne(
            { id: run.id },
            { $inc: { 'progress.users_created': 1 } }
        );

        const numDevices = Math.floor(Math.random() * (run.config.devices_max - run.config.devices_min + 1)) + run.config.devices_min;
        
        await db.collection('simulation_runs').updateOne(
            { id: run.id },
            { $inc: { 'progress.devices_requested': numDevices } }
        );

        const runtimeManager = getRuntimeManager(this.logger);

        for (let j = 0; j < numDevices; j++) {
            const product = this.pickProduct(run.config.products);
            const { mac, rawSecret } = await provisionMockDevice(product.product_id);
            
            await db.collection('simulation_runs').updateOne({ id: run.id }, { $inc: { 'progress.devices_provisioned': 1 } });
            
            await apiGateway.claimDevice(session.accessToken, {
                mac,
                secret_key: rawSecret,
                name: `Virtual Device ${index}-${j}`
            });
            
            const encryptedSecret = encrypt(rawSecret);

            await db.collection('simulated_devices').insertOne({
                run_id: run.id,
                simulator_user_id: registeredUser.id,
                mac,
                product_id: product.product_id,
                secret: encryptedSecret,
                runtime_state: 'claimed',
                seq: 0,
                created_at: new Date()
            });

            await db.collection('simulation_runs').updateOne({ id: run.id }, { $inc: { 'progress.devices_claimed': 1 } });

            // Automatically start device if requested
            if (run.config.auto_start) {
                // Apply initial offline rate
                if (Math.random() * 100 > run.config.initial_offline_rate) {
                    const intervalMs = run.config.telemetry_interval * 1000;
                    const device = runtimeManager.addDevice(mac, product.product_id, intervalMs, 0);
                    await device.connect();
                }
            }
        }
    }

    private pickProduct(products: {product_id: string, weight: number}[]): {product_id: string, weight: number} {
        const totalWeight = products.reduce((sum, p) => sum + p.weight, 0);
        let random = Math.random() * totalWeight;
        for (const product of products) {
            random -= product.weight;
            if (random <= 0) {
                return product;
            }
        }
        return products[0]; 
    }

    private async updateRunStatus(runId: string, status: string) {
        const db = getMongoDb();
        await db.collection('simulation_runs').updateOne(
            { id: runId },
            { $set: { status, updated_at: new Date() } }
        );
    }

    private async recordError(runId: string, errorMsg: string) {
        const db = getMongoDb();
        await db.collection('simulation_runs').updateOne(
            { id: runId },
            { 
                $inc: { total_errors: 1 },
                $set: { last_error: errorMsg, updated_at: new Date() }
            }
        );
    }
}
