import crypto from 'node:crypto';
import { deterministicHex } from './deterministic';

export interface GeneratedUser {
    email: string;
    password: string;
    full_name: string;
}

/**
 * Generates random user information.
 * @param index Sequence number to ensure uniqueness.
 * @param runId The ID of the simulation run.
 * @param emailDomain Domain to use for generated emails.
 * @param emailPrefix Prefix for the generated email local part.
 */
export const generateUser = (
    index: number, 
    runId: string, 
    emailDomain: string = 'simulator.local', 
    emailPrefix: string = 'sim',
    randomSeed?: string,
): GeneratedUser => {
    const shortRunId = runId.replace(/^run-/, '').substring(0, 6);
    const seed = randomSeed || runId;
    const suffix = deterministicHex(seed, `user:${runId}:${index}`, 2);
    
    const email = `${emailPrefix}_${shortRunId}_${index}_${suffix}@${emailDomain}`;
    const password = `${crypto.randomBytes(12).toString('base64url')}A1!`;
    const full_name = `Simulated User ${shortRunId}-${index}`;

    return {
        email,
        password,
        full_name
    };
};
