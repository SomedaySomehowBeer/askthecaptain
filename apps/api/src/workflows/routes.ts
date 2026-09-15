import { Hono } from 'hono';
import { z } from 'zod';
import type { Session } from '../auth/service.ts';
import type { WorkflowService } from './service.ts';

type Vars = { Variables: { requestId: string; session: Session } };
const uuid = z.string().uuid();
const key = z.string().regex(/^[a-z][a-z0-9-]{1,40}$/);

/** The workflow catalogue, enablement and journal under an organisation. Mounted inside the
 *  signed-in router; the service checks membership and role on every call. */
export function workflowRoutes(workflows: WorkflowService) {
	const routes = new Hono<Vars>();
	const actor = (c: { get(key: 'session'): Session; get(key: 'requestId'): string }) => ({ userId: c.get('session').userId, requestId: c.get('requestId') });
	const org = (c: { req: { param(name: 'id'): string } }) => uuid.parse(c.req.param('id'));

	routes.get('/v1/organisations/:id/workflows', async (c) => c.json({ workflows: await workflows.list(actor(c), org(c)) }));
	routes.put('/v1/organisations/:id/workflows/:key', async (c) => {
		const input = z.object({ enabled: z.boolean(), parameters: z.record(z.string(), z.unknown()).optional() }).parse(await c.req.json());
		return c.json(await workflows.enable(actor(c), org(c), key.parse(c.req.param('key')), input));
	});
	routes.get('/v1/organisations/:id/workflows/runs', async (c) => {
		const query = z.object({ key: key.optional(), limit: z.coerce.number().int().min(1).max(200).optional() }).parse({ key: c.req.query('key') || undefined, limit: c.req.query('limit') || undefined });
		return c.json({ runs: await workflows.runs(actor(c), org(c), query) });
	});
	routes.get('/v1/organisations/:id/workflows/runs/:runId', async (c) => c.json(await workflows.run(actor(c), org(c), uuid.parse(c.req.param('runId')))));
 routes.post('/v1/organisations/:id/workflows/:key/run', async c => c.json(await workflows.control(actor(c), org(c), key.parse(c.req.param('key')), 'run'), 202));
 for (const action of ['resume', 'cancel'] as const) routes.post(`/v1/organisations/:id/workflows/runs/:runId/${action}`, async c => c.json(await workflows.control(actor(c), org(c), uuid.parse(c.req.param('runId')), action)));
	return routes;
}
