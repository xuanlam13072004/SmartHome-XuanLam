import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ChatMessage } from './gemini';

/**
 * Short-lived assistant memory in Redis: the last few messages (so "đóng lại
 * đi" or an answer to a question back makes sense) and commands waiting for
 * the user's confirmation. Shared by every Gateway instance.
 */

const HISTORY_MESSAGES = 8;
const HISTORY_SECONDS = 15 * 60;
const PENDING_SECONDS = 5 * 60;

const historyKey = (accountId: string) => `assistant:history:${accountId}`;
const pendingKey = (accountId: string, id: string) => `assistant:pending:${accountId}:${id}`;

export interface PendingAction {
    id: string;
    kind: 'device' | 'scene';
    label: string;
    target: string;
    confirmation: 'confirm' | 'reauthenticate';
    mac?: string;
    instance_id?: string;
    operation?: string;
    input?: Record<string, unknown>;
    scene_id?: string;
}

type WithRedis = Pick<FastifyInstance, 'redis'>;

export async function readHistory(app: WithRedis, accountId: string): Promise<ChatMessage[]> {
    const raw = await app.redis.get(historyKey(accountId));
    try {
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

export async function appendHistory(app: WithRedis, accountId: string, messages: ChatMessage[]) {
    const history = [...(await readHistory(app, accountId)), ...messages].slice(-HISTORY_MESSAGES);
    await app.redis.set(historyKey(accountId), JSON.stringify(history), 'EX', HISTORY_SECONDS);
}

export async function clearHistory(app: FastifyInstance, accountId: string) {
    await app.redis.del(historyKey(accountId));
}

export async function savePending(app: FastifyInstance, accountId: string, pending: Omit<PendingAction, 'id'>) {
    const id = crypto.randomBytes(9).toString('base64url');
    await app.redis.set(pendingKey(accountId, id), JSON.stringify({ ...pending, id }), 'EX', PENDING_SECONDS);
    return id;
}

export async function peekPending(app: FastifyInstance, accountId: string, id: string): Promise<PendingAction | null> {
    if (!/^[A-Za-z0-9_-]{8,32}$/.test(id)) return null;
    const raw = await app.redis.get(pendingKey(accountId, id));
    return raw ? JSON.parse(raw) as PendingAction : null;
}

/** Removes and returns it: a confirmation runs once even if sent twice. */
export async function takePending(app: FastifyInstance, accountId: string, id: string): Promise<PendingAction | null> {
    const results = await app.redis.multi().get(pendingKey(accountId, id)).del(pendingKey(accountId, id)).exec();
    const raw = results?.[0]?.[1] as string | null | undefined;
    return raw && Number(results?.[1]?.[1]) === 1 ? JSON.parse(raw) as PendingAction : null;
}
