import { Hono } from 'hono';
import { z } from 'zod';
import type { Session } from '../auth/service.ts';
import type { DiscoveryService } from './service.ts';
type Vars = { Variables: { requestId: string; session: Session } };
const uuid = z.string().uuid();
export function discoveryRoutes(discovery: DiscoveryService) {
	const routes = new Hono<Vars>();
	const actor = (c: { get(key: 'session'): Session; get(key: 'requestId'): string }) => ({ userId: c.get('session').userId, requestId: c.get('requestId') });
	routes.post('/v1/organisations/:id/discovery/requests', async (c) => {
		const input = z.object({ kind: z.enum(['mail_thread', 'note']), id: uuid }).strict().parse(await c.req.json());
		return c.json(await discovery.request(actor(c), uuid.parse(c.req.param('id')), input), 202);
	});
	for (const decision of ['accept', 'discard'] as const) routes.post(`/v1/organisations/:id/projects/:projectId/${decision}`, async (c) => c.json(await discovery.decide(actor(c), uuid.parse(c.req.param('id')), uuid.parse(c.req.param('projectId')), decision)));
	return routes;
}
