import crypto from 'crypto';

export interface GeneratedUser {
    username: string;
    email: string;
    password: string;
    full_name: string;
}

/**
 * Generates random user information.
 * @param index Sequence number to ensure uniqueness.
 * @param runId The ID of the simulation run.
 * @param emailDomain Domain to use for generated emails.
 * @param usernamePrefix Prefix for generated usernames.
 */
export const generateUser = (
    index: number, 
    runId: string, 
    emailDomain: string = 'simulator.local', 
    usernamePrefix: string = 'sim'
): GeneratedUser => {
    // We use a portion of the runId to make usernames somewhat unique across runs
    const shortRunId = runId.substring(0, 5);
    const suffix = crypto.randomBytes(2).toString('hex'); // 4 chars random
    
    const username = `${usernamePrefix}_${shortRunId}_${index}_${suffix}`;
    const email = `${username}@${emailDomain}`;
    const password = crypto.randomBytes(8).toString('hex') + 'A1!'; // Ensure complexity
    const full_name = `Simulated User ${shortRunId}-${index}`;

    return {
        username,
        email,
        password,
        full_name
    };
};
