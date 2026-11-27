import { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { bodyFieldKey } from '../../plugins/rateLimit';
import { typedRouteConfig } from '../../plugins/validation';
import { accountDetail, disableAccount, enableAccount, giftPlan, listAccounts, signOutAccount } from './accounts';
import { listAdminActions, recordAdminAction } from './audit';
import { adminGuard, STAFF_CLIENT_HEADER, STAFF_CLIENT_IP_HEADER, staffOf } from './guard';
import { adminAssistant, adminOverview, giftablePlans } from './overview';
import { cancelPayment, confirmPayment, listPayments } from './payments';
import { STAFF_PERMISSIONS, STAFF_PRESETS, staffCan } from './permissions';
import {
    accountActionSchema,
    accountSchema,
    auditSchema,
    cancelPaymentSchema,
    confirmPaymentSchema,
    createStaffSchema,
    giftPlanSchema,
    listAccountsSchema,
    listPaymentsSchema,
    ownPasswordSchema,
    simulatorAuditSchema,
    staffActionSchema,
    staffLoginSchema,
    updateStaffSchema,
    weatherAccountMockSchema,
    weatherAccountParams,
    weatherAreaSchema,
    weatherMockSchema,
} from './schemas';
import { env } from '../../config/env';
import { httpError } from '../../utils/httpError';
import { PROVINCES } from '../weather/provinces';
import {
    clearAccountMock,
    listAccountMocks,
    listMocks,
    locationOf,
    setAccountMock,
    setMock,
    weatherStatus,
} from '../weather/service';
import {
    actOnStaff,
    actorOf,
    changeOwnPassword,
    createStaff,
    listOwnSessions,
    listStaff,
    loginStaff,
    logoutStaff,
    revokeOtherOwnSessions,
    updateStaff,
} from './staff';

/**
 * Administration API (docs/architecture/admin.md), called only by the Admin
 * Console's backend. Every route checks the server key and the staff
 * member's session and permission first (guard.ts); every change to a
 * customer, an order or a staff member goes to admin_audit_log.
 */
const header = (request: FastifyRequest, name: string) => {
    const value = request.headers[name];
    return typeof value === 'string' ? value : undefined;
};

const adminRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
    // onRequest, scoped to this plugin: checked before anything else (even
    // input validation) on every route below.
    app.addHook('onRequest', adminGuard(app));
    const loginLimit = app.limitBy('staff-login', bodyFieldKey('email'), 10);

    // ── Signing in and the signed-in staff member ──────────────────────────

    app.post('/admin/staff/login', {
        preHandler: [loginLimit],
        config: typedRouteConfig({ zodSchema: staffLoginSchema, adminPermission: 'none' }),
    }, async (request) => {
        const body = request.body as any;
        return {
            success: true,
            ...(await loginStaff(app, {
                email: body.email, password: body.password,
                client: header(request, STAFF_CLIENT_HEADER), ip: header(request, STAFF_CLIENT_IP_HEADER),
            })),
        };
    });

    app.post('/admin/staff/logout', {
        config: { adminPermission: 'signed-in', beforePasswordChange: true },
    }, async (request) => {
        await logoutStaff(app, staffOf(request).session_id);
        return { success: true };
    });

    app.get('/admin/staff/me', {
        config: { adminPermission: 'signed-in', beforePasswordChange: true },
    }, async (request) => {
        const staff = staffOf(request);
        return {
            success: true,
            staff: {
                id: staff.id, email: staff.email, full_name: staff.full_name, is_root: staff.is_root,
                permissions: staff.permissions, must_change_password: staff.must_change_password,
            },
        };
    });

    app.post('/admin/staff/me/password', {
        config: typedRouteConfig({ zodSchema: ownPasswordSchema, adminPermission: 'signed-in', beforePasswordChange: true }),
    }, async (request) => {
        await changeOwnPassword(app, staffOf(request), request.body as any);
        return { success: true };
    });

    app.get('/admin/staff/me/sessions', {
        config: { adminPermission: 'signed-in' },
    }, async (request) => ({ success: true, sessions: await listOwnSessions(app, staffOf(request)) }));

    app.post('/admin/staff/me/sessions/revoke-others', {
        config: { adminPermission: 'signed-in' },
    }, async (request) => ({ success: true, signed_out_sessions: await revokeOtherOwnSessions(app, staffOf(request)) }));

    app.get('/admin/permissions', {
        config: { adminPermission: 'signed-in' },
    }, async () => ({ success: true, permissions: STAFF_PERMISSIONS, presets: STAFF_PRESETS }));

    // ── Staff, managed by the root ─────────────────────────────────────────

    app.get('/admin/staff', {
        config: { adminPermission: 'staff.manage' },
    }, async () => ({ success: true, staff: await listStaff(app) }));

    app.post('/admin/staff', {
        config: typedRouteConfig({ zodSchema: createStaffSchema, adminPermission: 'staff.manage' }),
    }, async (request) => ({ success: true, ...(await createStaff(app, staffOf(request), request.body as any)) }));

    app.patch('/admin/staff/:id', {
        config: typedRouteConfig({ zodSchema: updateStaffSchema, adminPermission: 'staff.manage' }),
    }, async (request) => ({
        success: true,
        staff: await updateStaff(app, staffOf(request), (request.params as any).id, request.body as any),
    }));

    app.post('/admin/staff/:id/:action', {
        config: typedRouteConfig({ zodSchema: staffActionSchema, adminPermission: 'staff.manage' }),
    }, async (request) => {
        const params = request.params as any;
        return {
            success: true,
            ...(await actOnStaff(app, staffOf(request), params.id, params.action, (request.body as any).reason)),
        };
    });

    // ── Numbers ────────────────────────────────────────────────────────────

    app.get('/admin/overview', { config: { adminPermission: 'overview.view' } },
        async () => ({ success: true, ...(await adminOverview(app)) }));

    app.get('/admin/assistant', { config: { adminPermission: 'assistant.view' } },
        async () => ({ success: true, ...(await adminAssistant(app)) }));

    // ── Customers' accounts ────────────────────────────────────────────────

    app.get('/admin/plans', { config: { adminPermission: 'plans.gift' } },
        async () => ({ success: true, plans: await giftablePlans(app) }));

    app.get('/admin/accounts', {
        config: typedRouteConfig({ zodSchema: listAccountsSchema, adminPermission: 'accounts.view' }),
    }, async (request) => {
        const query = request.query as any;
        return {
            success: true,
            ...(await listAccounts(app, { q: query.q, filter: query.filter, page: query.page, pageSize: query.page_size })),
        };
    });

    app.get('/admin/accounts/:id', {
        config: typedRouteConfig({ zodSchema: accountSchema, adminPermission: 'accounts.view' }),
    }, async (request) => {
        const detail = await accountDetail(app, (request.params as any).id);
        // The account's admin history is part of the log: shown only with audit.view.
        return { success: true, ...detail, admin_log: staffCan(staffOf(request), 'audit.view') ? detail.admin_log : null };
    });

    for (const [path, act] of [
        ['disable', disableAccount],
        ['enable', enableAccount],
        ['sign-out', signOutAccount],
    ] as const) {
        app.post(`/admin/accounts/:id/${path}`, {
            config: typedRouteConfig({ zodSchema: accountActionSchema, adminPermission: 'accounts.manage' }),
        }, async (request) => ({
            success: true,
            ...(await act(app, (request.params as any).id, (request.body as any).reason, actorOf(staffOf(request)))),
        }));
    }

    app.post('/admin/accounts/:id/gift-plan', {
        config: typedRouteConfig({ zodSchema: giftPlanSchema, adminPermission: 'plans.gift' }),
    }, async (request) => ({
        success: true,
        gift: await giftPlan(app, (request.params as any).id, request.body as any, actorOf(staffOf(request))),
    }));

    // ── Payments ───────────────────────────────────────────────────────────

    app.get('/admin/payments', {
        config: typedRouteConfig({ zodSchema: listPaymentsSchema, adminPermission: 'payments.view' }),
    }, async (request) => {
        const query = request.query as any;
        return { success: true, ...(await listPayments(app, { tab: query.tab, page: query.page, pageSize: query.page_size })) };
    });

    app.post('/admin/payments/:code/confirm', {
        config: typedRouteConfig({ zodSchema: confirmPaymentSchema, adminPermission: 'payments.manage' }),
    }, async (request) => ({
        success: true,
        ...(await confirmPayment(app, (request.params as any).code, request.body as any, actorOf(staffOf(request)))),
    }));

    app.post('/admin/payments/:code/cancel', {
        config: typedRouteConfig({ zodSchema: cancelPaymentSchema, adminPermission: 'payments.manage' }),
    }, async (request) => ({
        success: true,
        ...(await cancelPayment(app, (request.params as any).code, (request.body as any).reason, actorOf(staffOf(request)))),
    }));

    // ── The log ────────────────────────────────────────────────────────────

    app.get('/admin/audit', {
        config: typedRouteConfig({ zodSchema: auditSchema, adminPermission: 'audit.view' }),
    }, async (request) => {
        const query = request.query as any;
        return {
            success: true,
            ...(await listAdminActions(app.pg, {
                page: query.page, pageSize: query.page_size, action: query.action,
                accountId: query.account_id, staffId: query.staff_id,
            })),
        };
    });

    /** The Console writes here each change a staff member made in the Simulator. */
    app.post('/admin/audit/simulator', {
        config: typedRouteConfig({ zodSchema: simulatorAuditSchema, adminPermission: 'simulator.manage' }),
    }, async (request) => {
        const body = request.body as any;
        await recordAdminAction(app.pg, {
            actor: actorOf(staffOf(request)), action: 'simulator.request', reason: 'Thao tác trong Simulator',
            details: { method: body.method, path: body.path, status: body.status },
        });
        return { success: true };
    });

    // ── Weather (docs/architecture/weather.md) ──────────────────────────────
    // Live: how fresh the 63 areas' forecasts are and today's Open-Meteo calls.
    // Mock weather for demos and tests instead of waiting for real rain: for
    // one account (live or mock, ends by itself), or, with WEATHER_MODE=mock
    // only, for a province or every area.

    /** The accounts with a mock, with their email and home (a mock does nothing without a home). */
    const accountMocks = async () => {
        if (env.WEATHER_MODE === 'off') return [];
        const mocks = await listAccountMocks(app);
        if (mocks.length === 0) return [];
        const rows = new Map((await app.pg.query(
            `SELECT account.id, account.email, account.full_name, preference.home_latitude, preference.home_longitude
             FROM accounts AS account
             LEFT JOIN account_preferences AS preference ON preference.account_id = account.id
             WHERE account.id = ANY($1::uuid[])`,
            [mocks.map(mock => mock.account_id)],
        )).rows.map(row => [row.id as string, row]));
        return mocks.flatMap(({ account_id, ...mock }) => {
            const row = rows.get(account_id);
            return row ? [{
                account_id, email: row.email as string, full_name: row.full_name as string,
                place: locationOf(row)?.place ?? null, ...mock,
            }] : [];
        });
    };

    app.get('/admin/weather', {
        config: { adminPermission: 'simulator.view' },
    }, async () => ({
        success: true,
        mode: env.WEATHER_MODE,
        provinces: PROVINCES.map(({ code, name }) => ({ code, name })),
        mocks: env.WEATHER_MODE === 'mock' ? await listMocks(app) : {},
        accounts: await accountMocks(),
        live: env.WEATHER_MODE === 'live' ? await weatherStatus(app) : null,
    }));

    const assertWeatherOn = () => {
        if (env.WEATHER_MODE === 'off') throw httpError(409, 'WEATHER_OFF', 'Weather is turned off on the API Gateway');
    };

    app.put('/admin/weather/account-mock', {
        config: typedRouteConfig({ zodSchema: weatherAccountMockSchema, adminPermission: 'simulator.manage' }),
    }, async (request) => {
        assertWeatherOn();
        const { email, hours, ...mock } = request.body as any;
        const account = (await app.pg.query('SELECT id, email FROM accounts WHERE lower(email) = $1', [email])).rows[0];
        if (!account) throw httpError(404, 'ACCOUNT_NOT_FOUND', 'Không tìm thấy tài khoản.');
        await setAccountMock(app, account.id, mock, hours);
        await recordAdminAction(app.pg, {
            actor: actorOf(staffOf(request)), action: 'weather.account_mock_set', reason: 'Thời tiết giả lập cho một tài khoản',
            targetAccountId: account.id, targetEmail: account.email, details: { ...mock, hours },
        });
        return { success: true, accounts: await accountMocks() };
    });

    app.delete('/admin/weather/account-mock/:id', {
        config: typedRouteConfig({ zodSchema: weatherAccountParams, adminPermission: 'simulator.manage' }),
    }, async (request) => {
        assertWeatherOn();
        const { id } = request.params as { id: string };
        if (await clearAccountMock(app, id)) {
            const account = (await app.pg.query('SELECT email FROM accounts WHERE id = $1', [id])).rows[0];
            await recordAdminAction(app.pg, {
                actor: actorOf(staffOf(request)), action: 'weather.account_mock_cleared', reason: 'Thời tiết giả lập cho một tài khoản',
                targetAccountId: id, targetEmail: account?.email ?? null,
            });
        }
        return { success: true, accounts: await accountMocks() };
    });

    const assertMock = () => {
        if (env.WEATHER_MODE !== 'mock') {
            throw httpError(409, 'WEATHER_NOT_MOCK', 'Mock weather needs WEATHER_MODE=mock on the API Gateway');
        }
    };

    app.put('/admin/weather/mock', {
        config: typedRouteConfig({ zodSchema: weatherMockSchema, adminPermission: 'simulator.manage' }),
    }, async (request) => {
        assertMock();
        const { area, ...mock } = request.body as any;
        await setMock(app, area, mock);
        await recordAdminAction(app.pg, {
            actor: actorOf(staffOf(request)), action: 'weather.mock_set', reason: 'Thời tiết giả lập',
            details: { area, ...mock },
        });
        return { success: true, mocks: await listMocks(app) };
    });

    app.delete('/admin/weather/mock/:area', {
        config: typedRouteConfig({ zodSchema: weatherAreaSchema, adminPermission: 'simulator.manage' }),
    }, async (request) => {
        assertMock();
        const { area } = request.params as { area: string };
        await setMock(app, area, null);
        await recordAdminAction(app.pg, {
            actor: actorOf(staffOf(request)), action: 'weather.mock_cleared', reason: 'Thời tiết giả lập',
            details: { area },
        });
        return { success: true, mocks: await listMocks(app) };
    });
};

export default adminRoutes;
