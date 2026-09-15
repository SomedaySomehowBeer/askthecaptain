import { Hono } from 'hono';
import { z } from 'zod';
import { withTenant, type Sql } from '@captain/db';
import type { Session } from '../auth/service.ts';
import { badRequest } from '../errors.ts';
import { xeroRole, type XeroConnections } from './connections.ts';
import { XeroService } from './service.ts';
import type { XeroSync } from './sync.ts';
type Vars = { Variables: { requestId: string; session: Session } };
export function xeroRoutes(deps: { db: Sql; xeroConnections?: XeroConnections; xeroSync?: XeroSync; xeroScheduleEnabled?: boolean }) {
 const routes = new Hono<Vars>(); const uuid = z.string().uuid(); const reads = new XeroService(deps.db);
 const service = () => { if (!deps.xeroConnections) throw badRequest('xero_unavailable', 'Xero connections are not configured.'); return deps.xeroConnections; };
 const actor = (c: { get(key: 'session'): Session; get(key: 'requestId'): string }) => ({ userId: c.get('session').userId, requestId: c.get('requestId') });
 routes.get('/v1/organisations/:id/xero/connection', async (c) => {
  const org = uuid.parse(c.req.param('id'));
  if (!deps.xeroConnections) { await withTenant(deps.db, { organisationId: org, userId: actor(c).userId }, (tx) => xeroRole(tx, actor(c), org)); return c.json({ available: false, connection: null, selection: null, lastSyncedAt: null, complete: false, syncError: null, scheduled: false }); }
  return c.json({ ...await service().status(actor(c), org), scheduled: Boolean(deps.xeroScheduleEnabled) });
 });
 routes.post('/v1/organisations/:id/xero/start', async (c) => c.json({ authorizationUrl: await service().start(actor(c), uuid.parse(c.req.param('id'))) }));
 routes.post('/v1/organisations/:id/xero/select', async (c) => { const input = z.object({ selectionId: uuid, tenantId: z.string().min(1).max(200) }).parse(await c.req.json()); await service().select(actor(c), uuid.parse(c.req.param('id')), input.selectionId, input.tenantId); return c.json({ ok: true }); });
 routes.delete('/v1/organisations/:id/xero/connection', async (c) => { await service().disconnect(actor(c), uuid.parse(c.req.param('id'))); return c.json({ ok: true }); });
 routes.post('/v1/organisations/:id/xero/sync', async (c) => {
  const org = uuid.parse(c.req.param('id')); await withTenant(deps.db, { organisationId: org, userId: actor(c).userId }, (tx) => xeroRole(tx, actor(c), org, true));
  if (!deps.xeroSync) throw badRequest('xero_unavailable', 'Xero sync is not configured.'); return c.json(await deps.xeroSync.run(org));
 });
 routes.get('/v1/organisations/:id/xero/receivables', async (c) => c.json(await reads.read(actor(c), uuid.parse(c.req.param('id')), z.coerce.number().int().min(0).max(36500).default(0).parse(c.req.query('overdueDays')), z.coerce.number().int().min(0).max(1_000_000).default(0).parse(c.req.query('offset')))));
 routes.get('/v1/organisations/:id/xero/summary', async (c) => c.json(await reads.read(actor(c), uuid.parse(c.req.param('id')))));
 return routes;
}
