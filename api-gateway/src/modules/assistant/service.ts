import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { env } from '../../config/env';
import { httpError } from '../../utils/httpError';
import { createDeviceOperation } from '../device/service';
import { startRun } from '../scenes/runs';
import { paymentsAvailable } from '../payments/service';
import { clearVoiceFailures, recordVoiceFailure, voiceLockState } from '../voice/lockout';
import { loadHomeContext, withAccount } from './context';
import { draftProblemReply, draftReply } from './drafts';
import { storeDraft } from './draftStore';
import { type GenerateFn, geminiGenerate } from './gemini';
import { appendHistory, type PendingAction, peekPending, readHistory, savePending, takePending } from './memory';
import { type PlanOffer, planTurn, type ProposedAction } from './planner';
import { addUsage, assertQuota, listPlans, usageSummary } from './quota';
import { clip } from './text';

/**
 * One assistant turn: quota → home context → the model's plan (checked) →
 * voice verification for commands → run through the normal device and scene
 * paths → a reply written by the server. Questions, chat and state answers
 * never run anything.
 */

export interface VoiceInput {
    transcript: string;
    verification: { accepted: boolean; reason: string | null } | null;
}

export interface ActionResult {
    kind: 'device' | 'scene';
    label: string;
    target: string;
    status: 'sent' | 'pending' | 'failed' | 'refused';
    reason?: string;
    pending_id?: string;
    confirmation?: 'confirm' | 'reauthenticate';
}

export type TurnOutcome = 'chat' | 'action' | 'clarify' | 'confirm' | 'refused' | 'error';

const FAILURES: Record<string, string> = {
    DEVICE_NOT_FOUND: 'thiết bị không còn trong nhà',
    OPERATION_FORBIDDEN: 'bạn không có quyền làm việc này',
    OPERATION_NOT_SUPPORTED: 'thiết bị không hỗ trợ',
    OPERATION_INPUT_INVALID: 'giá trị không hợp lệ',
    REAUTHENTICATION_REQUIRED: 'cần nhập mật khẩu',
    PRODUCT_REVISION_UNAVAILABLE: 'thiết bị cần cập nhật',
    SCENE_NOT_FOUND: 'kịch bản không còn',
    SCENE_ALREADY_RUNNING: 'kịch bản đang chạy',
    SCENE_EMPTY: 'kịch bản chưa có bước nào',
};

function failure(app: FastifyInstance, error: any): string {
    if (!error?.statusCode) app.log.warn({ error }, 'An assistant command failed unexpectedly');
    return FAILURES[error?.code] ?? 'có lỗi xảy ra';
}

function describe(action: ProposedAction): { kind: 'device' | 'scene'; label: string; target: string } {
    return action.kind === 'device'
        ? { kind: 'device', label: action.action.label, target: action.action.device }
        : { kind: 'scene', label: 'Chạy kịch bản', target: action.scene.name };
}

/** Sends a command now; a pending one comes back from the user's confirmation. */
async function execute(
    app: FastifyInstance,
    accountId: string,
    command: Omit<PendingAction, 'id' | 'confirmation' | 'label' | 'target'>,
    options: { reauthenticated: boolean; key: string },
): Promise<{ status: 'sent' | 'failed'; reason?: string }> {
    try {
        if (command.kind === 'device') {
            await createDeviceOperation(app, {
                mac: command.mac!,
                instance_id: command.instance_id!,
                operation_name: command.operation!,
                input: command.input ?? {},
                idempotency_key: options.key,
                reauthenticated: options.reauthenticated,
            }, accountId);
        } else {
            await startRun(app, accountId, command.scene_id!, { reauthenticated: options.reauthenticated });
        }
        return { status: 'sent' };
    } catch (error) {
        return { status: 'failed', reason: failure(app, error) };
    }
}

function resultLine(result: ActionResult): string {
    const what = result.kind === 'scene' ? `kịch bản "${result.target}"` : `"${result.label}" (${result.target})`;
    switch (result.status) {
        case 'sent':
            return result.kind === 'scene' ? `Đã chạy ${what}.` : `Đã gửi lệnh ${what}.`;
        case 'pending':
            return result.confirmation === 'reauthenticate'
                ? `${what[0].toUpperCase()}${what.slice(1)} cần nhập mật khẩu để xác nhận.`
                : `${what[0].toUpperCase()}${what.slice(1)} cần bạn xác nhận.`;
        default:
            return `Không thực hiện được ${what}: ${result.reason}.`;
    }
}

/** A plan the user may buy from the chat; the order is created only when they tap to confirm. */
export interface OfferView {
    plan: { code: string; name: string };
    months: 1 | 12 | null;
    prices: Array<{ months: 1 | 12; amount_vnd: number }>;
}

const vnd = (value: number) => `${value.toLocaleString('vi-VN')}đ`;
const term = (months: number) => (months === 12 ? '12 tháng' : '1 tháng');

function offerView(offer: PlanOffer): OfferView {
    const months = offer.months && offer.plan.prices.some(price => price.months === offer.months) ? offer.months : null;
    return { plan: { code: offer.plan.code, name: offer.plan.name }, months, prices: offer.plan.prices };
}

function offerLine(offer: OfferView, currentPlan: string): string {
    const verb = offer.plan.code === currentPlan ? 'gia hạn' : 'mua';
    const chosen = offer.prices.find(price => price.months === offer.months);
    if (chosen) {
        return `Bạn xác nhận ${verb} gói ${offer.plan.name} ${term(chosen.months)}, giá ${vnd(chosen.amount_vnd)} nhé? `
            + 'Mã thanh toán chỉ được tạo khi bạn bấm xác nhận.';
    }
    const prices = offer.prices.map(price => `${term(price.months)} ${vnd(price.amount_vnd)}`).join(', ');
    return `Gói ${offer.plan.name}: ${prices}. Bạn muốn ${verb} ${offer.prices.map(price => term(price.months)).join(' hay ')}?`;
}

const PAYMENTS_CLOSED = 'Hiện ứng dụng chưa mở thanh toán nên chưa mua gói được. Bạn vẫn dùng gói hiện tại bình thường.';

/** Why spoken commands are refused; null when the speaker may give them. */
async function voiceGate(app: FastifyInstance, accountId: string, voice: VoiceInput): Promise<string | null> {
    const lock = await voiceLockState(app, accountId);
    if (lock.locked_until) {
        const until = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' })
            .format(new Date(lock.locked_until));
        return `Ra lệnh bằng giọng nói đang tạm khóa đến ${until} vì nhiều lần không khớp giọng. Bạn vẫn có thể gõ lệnh.`;
    }
    if (!voice.verification) {
        return 'Để ra lệnh bằng giọng nói, hãy đăng ký giọng nói trong Cá nhân → Giọng nói. Bạn vẫn có thể gõ lệnh.';
    }
    if (!voice.verification.accepted) {
        const state = await recordVoiceFailure(app, accountId);
        const reason = voice.verification.reason === 'spoof_suspected'
            ? 'giọng nói có vẻ được phát lại từ loa' : 'giọng nói không khớp với chủ tài khoản';
        return state.locked_until
            ? `Mình không thực hiện vì ${reason}. Ra lệnh bằng giọng nói đã bị tạm khóa 15 phút.`
            : `Mình không thực hiện vì ${reason}.`;
    }
    await clearVoiceFailures(app, accountId);
    return null;
}

export async function runAssistantTurn(
    app: FastifyInstance,
    accountId: string,
    input: { channel: 'voice' | 'text'; message: string; voice?: VoiceInput },
    generate: GenerateFn = geminiGenerate(app.log),
) {
    const message = clip(input.message, 500);
    if (!message) throw httpError(400, 'ASSISTANT_EMPTY_MESSAGE', 'Hãy nhập hoặc nói một câu.');
    const quota = await assertQuota(app, accountId);
    const [home, history, plans] = await Promise.all([
        loadHomeContext(app, accountId), readHistory(app, accountId), listPlans(app),
    ]);
    const payments = paymentsAvailable();
    const context = withAccount(home, {
        plan: quota.plan, used_tokens: quota.used_tokens, resets_at: quota.resets_at, plans, payments,
    });
    const plan = await planTurn(generate, { context, history, message });
    if (plan.tokens > 0) await addUsage(app, accountId, plan.tokens);

    const turnId = crypto.randomUUID();
    const results: ActionResult[] = [];
    let reply: string;
    let outcome: TurnOutcome;
    const voiceVerified = input.voice?.verification ? input.voice.verification.accepted : null;
    const offer = !plan.blocked && plan.offer && payments ? offerView(plan.offer) : null;
    const offerText = plan.blocked || !plan.offer ? null : offer ? offerLine(offer, quota.plan.code) : PAYMENTS_CLOSED;
    // A draft is only shown; the user saves it (POST /assistant/drafts/:id/save).
    const draft = !plan.blocked && plan.draft ? await storeDraft(app, accountId, plan.draft) : null;
    const extras = [offerText, draft ? draftReply(draft) : null].filter((item): item is string => Boolean(item));
    const confirms = Boolean(offer || draft);
    const failedDraft = draft || plan.blocked ? undefined : plan.dropped.find(item => item.name === 'draft_automation');

    if (plan.blocked) {
        reply = 'Xin lỗi, mình không thể trả lời yêu cầu này.';
        outcome = 'refused';
    } else if (plan.actions.length > 0) {
        const refusal = input.channel === 'voice' ? await voiceGate(app, accountId, input.voice!) : null;
        if (refusal) {
            results.push(...plan.actions.map(action => ({ ...describe(action), status: 'refused' as const })));
            reply = refusal;
            outcome = 'refused';
        } else {
            for (const [index, action] of plan.actions.entries()) {
                const base = describe(action);
                const command = action.kind === 'device'
                    ? {
                        kind: 'device' as const, mac: action.action.mac, instance_id: action.action.instance_id,
                        operation: action.action.operation, input: action.input,
                    }
                    : { kind: 'scene' as const, scene_id: action.scene.scene_id };
                const confirmation = action.kind === 'device'
                    ? action.action.confirmation : (action.scene.protected ? 'reauthenticate' : null);
                if (confirmation) {
                    const pendingId = await savePending(app, accountId, { ...command, ...base, confirmation });
                    results.push({ ...base, status: 'pending', pending_id: pendingId, confirmation });
                } else {
                    results.push({ ...base, ...(await execute(app, accountId, command, {
                        reauthenticated: false, key: `assistant:${turnId}:${index}`,
                    })) });
                }
            }
            reply = results.map(resultLine).join(' ');
            outcome = results.some(item => item.status === 'pending') ? 'confirm'
                : results.some(item => item.status === 'sent') ? 'action' : 'error';
        }
        if (extras.length > 0) reply = [reply, ...extras].join(' ');
        if (confirms) outcome = 'confirm';
    } else if (extras.length > 0) {
        reply = extras.join(' ');
        outcome = confirms ? 'confirm' : 'chat';
    } else if (plan.clarification) {
        reply = plan.clarification.question;
        outcome = 'clarify';
    } else if (failedDraft) {
        // Never the model's own words here: it might claim something was set up.
        reply = draftProblemReply(failedDraft.reason, failedDraft.detail)
            ?? 'Mình chưa soạn được việc này. Bạn nói rõ thiết bị, thời gian và việc cần làm giúp mình nhé.';
        outcome = 'clarify';
    } else if (plan.text) {
        reply = clip(plan.text, 2000);
        outcome = 'chat';
    } else {
        reply = plan.dropped.length > 0
            ? 'Mình chưa chắc bạn muốn làm gì. Bạn nói rõ thiết bị và việc cần làm giúp mình nhé.'
            : 'Mình chưa hiểu ý bạn, bạn nói lại giúp mình nhé.';
        outcome = 'clarify';
    }

    await appendHistory(app, accountId, [
        { role: 'user', text: message },
        { role: 'model', text: reply, ...(outcome === 'clarify' ? { clarify: true } : {}) },
    ]);
    await app.pg.query(
        `INSERT INTO assistant_turns (id, account_id, channel, message, reply, outcome, actions, tokens, voice_verified)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
        [turnId, accountId, input.channel, message, clip(reply, 4000), outcome,
            JSON.stringify([
                ...results.map(({ pending_id: _, ...rest }) => rest),
                ...(offer ? [{ kind: 'offer', plan: offer.plan.code, months: offer.months }] : []),
                ...(draft ? [{ kind: 'draft', draft: draft.kind, name: draft.name }] : []),
            ]), plan.tokens, voiceVerified],
    );
    const usage = await usageSummary(app, accountId);
    return {
        turn_id: turnId,
        message,
        reply,
        outcome,
        actions: results,
        clarification: outcome === 'clarify' && plan.clarification ? plan.clarification : null,
        offer,
        draft,
        usage: { used_tokens: usage.used_tokens, monthly_tokens: usage.plan.monthly_tokens, plan: usage.plan.code },
    };
}

/** Runs a command the user confirmed (the password first when it needs one). */
export async function confirmPending(app: FastifyInstance, accountId: string, pendingId: string, reauthenticated: boolean) {
    const pending = await peekPending(app, accountId, pendingId);
    if (!pending) {
        throw httpError(404, 'ASSISTANT_PENDING_NOT_FOUND', 'Yêu cầu xác nhận đã hết hạn, hãy nói lại lệnh.');
    }
    if (pending.confirmation === 'reauthenticate' && !reauthenticated) {
        throw httpError(403, 'REAUTHENTICATION_REQUIRED', 'Recent reauthentication is required');
    }
    const taken = await takePending(app, accountId, pendingId);
    if (!taken) throw httpError(404, 'ASSISTANT_PENDING_NOT_FOUND', 'Yêu cầu xác nhận đã hết hạn, hãy nói lại lệnh.');
    const outcome = await execute(app, accountId, taken, { reauthenticated, key: `assistant:confirm:${taken.id}` });
    const result: ActionResult = { kind: taken.kind, label: taken.label, target: taken.target, ...outcome };
    const reply = resultLine(result);
    await appendHistory(app, accountId, [{ role: 'model', text: reply }]);
    return { action: result, reply };
}

export async function purgeOldAssistantTurns(app: FastifyInstance): Promise<number> {
    const result = await app.pg.query(
        `DELETE FROM assistant_turns WHERE id IN (
             SELECT id FROM assistant_turns WHERE created_at < NOW() - make_interval(days => $1) LIMIT 5000)`,
        [env.ASSISTANT_TURN_RETENTION_DAYS],
    );
    return result.rowCount ?? 0;
}
