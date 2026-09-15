import { Hono } from 'hono';
import { z } from 'zod';
import type { Session } from '../auth/service.ts';
import type { PushService } from './service.ts';

type Vars = { Variables: { requestId: string; session: Session } };
const uuid = z.string().uuid();

/** Push subscriptions for the signed-in person's devices. Mounted inside the signed-in router. */
export function pushRoutes(push: PushService) {
	const routes = new Hono<Vars>();
	const actor = (c: { get(key: 'session'): Session; get(key: 'requestId'): string }) => ({ userId: c.get('session').userId, requestId: c.get('requestId') });
	const org = (c: { req: { param(name: 'id'): string } }) => uuid.parse(c.req.param('id'));

	routes.get('/v1/push/config', (c) => c.json({ configured: push.configured, publicKey: push.publicKey }));
	routes.get('/v1/organisations/:id/push/subscriptions', async (c) => c.json({ subscriptions: await push.mine(actor(c), org(c)) }));
	routes.post('/v1/organisations/:id/push/subscriptions', async (c) => {
		const input = z.object({ endpoint: z.string().url(), keys: z.object({ p256dh: z.string().min(1).max(400), auth: z.string().min(1).max(200) }), userAgent: z.string().max(300).optional() }).parse(await c.req.json());
		return c.json(await push.subscribe(actor(c), org(c), input), 201);
	});
	routes.delete('/v1/organisations/:id/push/subscriptions', async (c) => {
		const input = z.object({ endpoint: z.string().url() }).parse(await c.req.json());
		await push.unsubscribe(actor(c), org(c), input.endpoint); return c.json({ ok: true });
	});
	routes.post('/v1/organisations/:id/push/test', async (c) => c.json({ deliveries: await push.test(actor(c), org(c)) }));
	return routes;
}
