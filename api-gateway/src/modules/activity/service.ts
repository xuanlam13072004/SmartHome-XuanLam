import type { FastifyInstance } from 'fastify';
import { httpError } from '../../utils/httpError';

type Kind = 'operation' | 'audit';

interface Cursor {
    /** Exact PostgreSQL timestamp text (microseconds survive the round trip). */
    t: string;
    k: Kind;
    i: string;
}

export function encodeCursor(cursor: Cursor): string {
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(value: string): Cursor {
    try {
        const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
        if (typeof cursor?.t === 'string' && (cursor.k === 'operation' || cursor.k === 'audit')
            && typeof cursor.i === 'string' && cursor.i.length <= 64) {
            return cursor;
        }
    } catch {
        // fall through
    }
    throw httpError(400, 'INVALID_CURSOR', 'Invalid page cursor');
}

let queryOperations: string[] | null = null;

/** Read-only queries (listing recordings…) are not activity worth showing. */
function hiddenOperations(app: FastifyInstance): string[] {
    if (!queryOperations) {
        const names = new Set<string>();
        for (const product of app.catalog.getAllProducts() as any[]) {
            for (const operation of Object.values(product.operations || {}) as any[]) {
                if (operation?.presentation?.ui_hint === 'query') names.add(operation.id ?? operation.operation_name);
            }
        }
        queryOperations = [...names].filter(Boolean).sort();
    }
    return queryOperations;
}

/**
 * "Lịch sử hoạt động": what this account did, newest first. Device commands
 * come from device_operations, account/sharing/device-management changes from
 * device_audit_logs; both are read by their (actor, time, id) index and merged.
 * Order: time desc, then operation before audit, then id desc. The cursor is
 * the last item, so pages never skip or repeat.
 */
export async function listActivity(
    app: FastifyInstance,
    accountId: string,
    options: { before?: string; limit: number },
) {
    const limit = options.limit;
    const cursor = options.before ? decodeCursor(options.before) : null;
    const params: unknown[] = [accountId, limit + 1, hiddenOperations(app)];
    let operationAfter = '';
    let auditAfter = '';
    if (cursor) {
        params.push(cursor.t, cursor.i);
        if (cursor.k === 'operation') {
            operationAfter = 'AND (operation.created_at, operation.id) < ($4::timestamptz, $5::uuid)';
            auditAfter = 'AND log.occurred_at <= $4::timestamptz';
        } else {
            operationAfter = 'AND operation.created_at < $4::timestamptz';
            auditAfter = 'AND (log.occurred_at, log.id) < ($4::timestamptz, $5::bigint)';
        }
    }

    const result = await app.pg.query(
        `SELECT * FROM (
            (SELECT 'operation' AS kind, operation.id::text AS id, operation.id::text AS sort_id,
                    operation.created_at AS at, operation.created_at::text AS at_text,
                    operation.operation_name AS action, operation.instance_id,
                    operation.status, operation.reason_code, NULL::jsonb AS metadata,
                    device.mac, device.name AS device_name, device.product_id
             FROM device_operations AS operation
             JOIN device_metadata AS device ON device.id = operation.device_id
             WHERE operation.actor_account_id = $1
               AND operation.operation_name <> ALL($3::text[])
               ${operationAfter}
             ORDER BY operation.created_at DESC, operation.id DESC
             LIMIT $2)
            UNION ALL
            (SELECT 'audit', log.id::text, lpad(log.id::text, 20, '0'),
                    log.occurred_at, log.occurred_at::text,
                    log.action, NULL, log.outcome, log.reason_code, log.metadata,
                    device.mac, device.name, device.product_id
             FROM device_audit_logs AS log
             LEFT JOIN device_metadata AS device ON device.id = log.device_id
             WHERE log.actor_account_id = $1
               ${auditAfter}
             ORDER BY log.occurred_at DESC, log.id DESC
             LIMIT $2)
         ) AS feed
         ORDER BY at DESC, kind DESC, sort_id DESC
         LIMIT $2`,
        params,
    );

    const rows = result.rows.slice(0, limit);
    const last = rows[rows.length - 1];
    return {
        items: rows.map(row => ({
            kind: row.kind as Kind,
            id: row.id,
            at: new Date(row.at).toISOString(),
            action: row.action,
            label: row.kind === 'operation'
                ? (app.catalog.getOperation(row.product_id, row.instance_id, row.action) as any)?.presentation?.label ?? null
                : null,
            status: row.status,
            reason_code: row.reason_code,
            device: row.mac ? { mac: row.mac, name: row.device_name, product_id: row.product_id } : null,
            metadata: row.metadata ?? {},
        })),
        next_cursor: result.rows.length > limit && last
            ? encodeCursor({ t: last.at_text, k: last.kind, i: last.id })
            : null,
    };
}
