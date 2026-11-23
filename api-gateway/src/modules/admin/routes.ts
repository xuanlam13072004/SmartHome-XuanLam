import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { typedRouteConfig } from '../../plugins/validation';
import { accountDetail, disableAccount, enableAccount, giftPlan, listAccounts, signOutAccount } from './accounts';
import { listAdminActions } from './audit';
import { adminGuard } from './guard';
import { adminAssistant, adminOverview, giftablePlans } from './overview';
import { cancelPayment, confirmPayment, listPayments } from './payments';
import {
    accountActionSchema,
    accountSchema,
    auditSchema,
    cancelPaymentSchema,
    confirmPaymentSchema,
    giftPlanSchema,
    listAccountsSchema,
    listPaymentsSchema,
} from './schemas';

/**
 * Administration API (docs/architecture/admin.md), for the Simulator's
 * "Quản trị" page only: every route checks the server key first (guard.ts)
 * and every change needs a reason that goes to admin_audit_log.
 */
const adminRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
    // onRequest, scoped to this plugin: the key is checked before anything
    // else (even input validation) on every route below.
    app.addHook('onRequest', adminGuard(app));

    app.get('/admin/overview', async () => ({ success: true, ...(await adminOverview(app)) }));

    app.get('/admin/assistant', async () => ({ success: true, ...(await adminAssistant(app)) }));

    app.get('/admin/plans', async () => ({ success: true, plans: await giftablePlans(app) }));

    app.get('/admin/accounts', {
        config: typedRouteConfig({ zodSchema: listAccountsSchema }),
    }, async (request) => {
        const query = request.query as any;
        return {
            success: true,
            ...(await listAccounts(app, { q: query.q, filter: query.filter, page: query.page, pageSize: query.page_size })),
        };
    });

    app.get('/admin/accounts/:id', {
        config: typedRouteConfig({ zodSchema: accountSchema }),
    }, async (request) => ({ success: true, ...(await accountDetail(app, (request.params as any).id)) }));

    app.post('/admin/accounts/:id/disable', {
        config: typedRouteConfig({ zodSchema: accountActionSchema }),
    }, async (request) => ({
        success: true,
        ...(await disableAccount(app, (request.params as any).id, (request.body as any).reason)),
    }));

    app.post('/admin/accounts/:id/enable', {
        config: typedRouteConfig({ zodSchema: accountActionSchema }),
    }, async (request) => ({
        success: true,
        ...(await enableAccount(app, (request.params as any).id, (request.body as any).reason)),
    }));

    app.post('/admin/accounts/:id/sign-out', {
        config: typedRouteConfig({ zodSchema: accountActionSchema }),
    }, async (request) => ({
        success: true,
        ...(await signOutAccount(app, (request.params as any).id, (request.body as any).reason)),
    }));

    app.post('/admin/accounts/:id/gift-plan', {
        config: typedRouteConfig({ zodSchema: giftPlanSchema }),
    }, async (request) => ({
        success: true,
        gift: await giftPlan(app, (request.params as any).id, request.body as any),
    }));

    app.get('/admin/payments', {
        config: typedRouteConfig({ zodSchema: listPaymentsSchema }),
    }, async (request) => {
        const query = request.query as any;
        return { success: true, ...(await listPayments(app, { tab: query.tab, page: query.page, pageSize: query.page_size })) };
    });

    app.post('/admin/payments/:code/confirm', {
        config: typedRouteConfig({ zodSchema: confirmPaymentSchema }),
    }, async (request) => ({
        success: true,
        ...(await confirmPayment(app, (request.params as any).code, request.body as any)),
    }));

    app.post('/admin/payments/:code/cancel', {
        config: typedRouteConfig({ zodSchema: cancelPaymentSchema }),
    }, async (request) => ({
        success: true,
        ...(await cancelPayment(app, (request.params as any).code, (request.body as any).reason)),
    }));

    app.get('/admin/audit', {
        config: typedRouteConfig({ zodSchema: auditSchema }),
    }, async (request) => {
        const query = request.query as any;
        return {
            success: true,
            ...(await listAdminActions(app.pg, {
                page: query.page, pageSize: query.page_size, action: query.action, accountId: query.account_id,
            })),
        };
    });
};

export default adminRoutes;
