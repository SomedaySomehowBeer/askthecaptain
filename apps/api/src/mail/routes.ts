import { Hono } from 'hono';
import { z } from 'zod';
import type { Session } from '../auth/service.ts';
import type { MailService } from './service.ts';
type Vars = { Variables: { requestId: string; session: Session } };
export function mailRoutes(mail: MailService) {
	const routes = new Hono<Vars>(); const uuid = z.string().uuid();
	const actor = (c: { get(key: 'session'): Session; get(key: 'requestId'): string }) => ({ userId: c.get('session').userId, requestId: c.get('requestId') });
	routes.get('/v1/organisations/:id/mail/threads', async (c) => {
		const { since, limit, before } = z.object({ since: z.string().datetime({ offset: true }).optional(), before: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(c.req.query());
		return c.json(await mail.list(actor(c), uuid.parse(c.req.param('id')), since, limit, before ? z.tuple([z.string().datetime({ offset: true }), uuid]).parse(before.split('|')) : undefined));
	});
	routes.get('/v1/organisations/:id/mail/threads/:threadId', async (c) => c.json(await mail.thread(actor(c), uuid.parse(c.req.param('id')), uuid.parse(c.req.param('threadId')))));
	routes.post('/v1/organisations/:id/mail/sync', async (c) => c.json(await mail.sync(actor(c), uuid.parse(c.req.param('id')))));
	return routes;
}
