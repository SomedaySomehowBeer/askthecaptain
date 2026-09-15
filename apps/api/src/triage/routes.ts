import { Hono } from 'hono';
import { z } from 'zod';
import type { Session } from '../auth/service.ts';
import type { OutboxService } from './outbox.ts';
export function outboxRoutes(outbox: OutboxService) {
 const routes = new Hono<{ Variables: { requestId: string; session: Session } }>();
 routes.get('/v1/organisations/:id/outbox', async c => c.json(await outbox.list({ userId: c.get('session').userId, requestId: c.get('requestId') }, z.uuid().parse(c.req.param('id')))));
 routes.post('/v1/organisations/:id/outbox', async c => c.json(await outbox.create({ userId: c.get('session').userId, requestId: c.get('requestId') }, z.uuid().parse(c.req.param('id')), await c.req.json()), 201));
 for (const action of ['edit', 'send', 'discard'] as const) routes.post(`/v1/organisations/:id/outbox/:draftId/${action}`, async c => {
  const actor = { userId: c.get('session').userId, requestId: c.get('requestId') }; const org = z.uuid().parse(c.req.param('id')); const id = z.uuid().parse(c.req.param('draftId'));
  return c.json(action === 'send' ? await outbox.send(actor, org, id) : await outbox.change(actor, org, id, action, action === 'edit' ? z.object({ body: z.string() }).parse(await c.req.json()).body : undefined));
 });
 return routes;
}
