import { Hono } from 'hono';
import { z } from 'zod';
import type { Session } from '../auth/service.ts';
import type { OutboxService } from './outbox.ts';
import type { TriageService } from './service.ts';
export function outboxRoutes(outbox: OutboxService) {
 const routes = new Hono<{ Variables: { requestId: string; session: Session } }>();
 routes.get('/v1/organisations/:id/outbox', async c => c.json(await outbox.list({ userId: c.get('session').userId, requestId: c.get('requestId') }, z.uuid().parse(c.req.param('id')))));
 routes.post('/v1/organisations/:id/outbox', async c => c.json(await outbox.create({ userId: c.get('session').userId, requestId: c.get('requestId') }, z.uuid().parse(c.req.param('id')), await c.req.json()), 201));
 for (const action of ['edit', 'send', 'discard', 'not_needed', 'remind'] as const) routes.post(`/v1/organisations/:id/outbox/:draftId/${action}`, async c => {
  const actor = { userId: c.get('session').userId, requestId: c.get('requestId') }; const org = z.uuid().parse(c.req.param('id')); const id = z.uuid().parse(c.req.param('draftId'));
  if (action === 'send') return c.json(await outbox.send(actor, org, id));
  const body = action === 'edit' ? z.object({ body: z.string() }).parse(await c.req.json()).body : undefined;
  const when = action === 'remind' ? z.object({ when: z.enum(['tomorrow', 'next_week']) }).parse(await c.req.json()).when : undefined;
  return c.json(await outbox.change(actor, org, id, action, body, when));
 });
 return routes;
}
/** Draft a reply, Not needed and Remind me later on a needs-you thread that has no draft (plan §6). */
export function threadRoutes(triage: TriageService) {
 const routes = new Hono<{ Variables: { requestId: string; session: Session } }>();
 const actor = (c: { get(key: 'session'): Session; get(key: 'requestId'): string }) => ({ userId: c.get('session').userId, requestId: c.get('requestId') });
 routes.post('/v1/organisations/:id/mail/threads/:threadId/draft', async c => c.json(await triage.requestDraft(actor(c), z.uuid().parse(c.req.param('id')), z.uuid().parse(c.req.param('threadId'))), 201));
 routes.post('/v1/organisations/:id/mail/threads/:threadId/not_needed', async c => c.json(await triage.threadAction(actor(c), z.uuid().parse(c.req.param('id')), z.uuid().parse(c.req.param('threadId')), 'not_needed')));
 routes.post('/v1/organisations/:id/mail/threads/:threadId/remind', async c => c.json(await triage.threadAction(actor(c), z.uuid().parse(c.req.param('id')), z.uuid().parse(c.req.param('threadId')), 'remind', z.object({ when: z.enum(['tomorrow', 'next_week']) }).parse(await c.req.json()).when)));
 return routes;
}
