import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { PROBE_LIMITS, probeCsv, type ProbeResult } from '../../workload/probe';
import { getProbeService } from '../../workload/probe-service';

const startSchema = z.object({
    kind: z.enum(['commands', 'app_reads']),
    users: z.number().int().min(1).max(PROBE_LIMITS.users),
    per_user: z.number().int().min(1).max(PROBE_LIMITS.per_user),
    concurrency: z.number().int().min(1).max(PROBE_LIMITS.concurrency),
});

const withoutSamples = ({ samples: _, ...rest }: ProbeResult) => rest;

/** End-to-end probes (docs/architecture/load-testing.md). */
const probeRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
    const probes = getProbeService(app.log);

    app.get('/api/probes', async (_request, reply) => {
        reply.header('Cache-Control', 'no-store');
        const live = probes.live();
        return {
            success: true,
            current: live ? withoutSamples(live) : null,
            results: (await probes.list()).filter(result => result.id !== live?.id),
            limits: PROBE_LIMITS,
        };
    });

    app.post('/api/probes', async (request, reply) => {
        const parsed = startSchema.safeParse(request.body);
        if (!parsed.success) return reply.status(400).send({ success: false, error: 'Thông số bài đo không hợp lệ.' });
        try {
            return reply.status(202).send({ success: true, probe: withoutSamples(probes.start(parsed.data)) });
        } catch (error: any) {
            return reply.status(error?.statusCode ?? 500).send({ success: false, error: error?.message ?? 'Không bắt đầu được bài đo.' });
        }
    });

    app.post('/api/probes/:id/stop', async (request, reply) => {
        const { id } = request.params as { id: string };
        if (!probes.stop(id)) return reply.status(404).send({ success: false, error: 'Không có bài đo này đang chạy.' });
        return { success: true };
    });

    app.get('/api/probes/:id', async (request, reply) => {
        const result = await probes.get((request.params as { id: string }).id);
        if (!result) return reply.status(404).send({ success: false, error: 'Không tìm thấy bài đo.' });
        return { success: true, probe: result };
    });

    app.get('/api/probes/:id/csv', async (request, reply) => {
        const result = await probes.get((request.params as { id: string }).id);
        if (!result) return reply.status(404).send({ success: false, error: 'Không tìm thấy bài đo.' });
        reply.header('Content-Type', 'text/csv; charset=utf-8');
        reply.header('Content-Disposition', `attachment; filename="probe-${result.params.kind}-${result.started_at.slice(0, 19).replace(/[:T]/g, '-')}.csv"`);
        return probeCsv(result);
    });
};

export default probeRoutes;
