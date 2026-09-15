import { Hono } from 'hono';
import { z } from 'zod';
import { withTenant, type Sql } from '@captain/db';
import type { Session } from '../auth/service.ts';
import { badRequest } from '../errors.ts';
import { shopifyRole, type ShopifyConnections } from './connections.ts';
import type { ShopifySync } from './sync.ts';
import { ShopifyService } from './service.ts';
export function shopifyRoutes(deps: { db: Sql; shopifyConnections?: ShopifyConnections; shopifySync?: ShopifySync; shopifyScheduleEnabled?: boolean }) {
 const routes = new Hono<{ Variables: { requestId: string; session: Session } }>(); const uuid = z.string().uuid(); const reads = new ShopifyService(deps.db);
 const service = () => { if (!deps.shopifyConnections) throw badRequest('shopify_unavailable', 'Shopify connections are not configured.'); return deps.shopifyConnections; };
 const actor = (c: { get(key: 'session'): Session; get(key: 'requestId'): string }) => ({ userId: c.get('session').userId, requestId: c.get('requestId') });
 routes.get('/v1/organisations/:id/shopify/connection', async (c) => {
  const org = uuid.parse(c.req.param('id'));
  if (!deps.shopifyConnections) { await withTenant(deps.db, { organisationId: org, userId: actor(c).userId }, (tx) => shopifyRole(tx, actor(c), org)); return c.json({ available: false, connected: false, connection: null, complete: false, lastSyncedAt: null, error: null, scheduled: false }); }
  return c.json({ ...await service().status(actor(c), org), scheduled: Boolean(deps.shopifyScheduleEnabled) });
 });
 routes.post('/v1/organisations/:id/shopify/start', async (c) => { const { shop } = z.object({ shop: z.string().min(1).max(100) }).strict().parse(await c.req.json()); return c.json({ authorizationUrl: await service().start(actor(c), uuid.parse(c.req.param('id')), shop) }); });
 routes.delete('/v1/organisations/:id/shopify/connection', async (c) => { await service().disconnect(actor(c), uuid.parse(c.req.param('id'))); return c.json({ ok: true }); });
 routes.post('/v1/organisations/:id/shopify/sync', async (c) => {
  const org = uuid.parse(c.req.param('id')); await withTenant(deps.db, { organisationId: org, userId: actor(c).userId }, (tx) => shopifyRole(tx, actor(c), org, true));
  if (!deps.shopifySync) throw badRequest('shopify_unavailable', 'Shopify sync is not configured.'); return c.json(await deps.shopifySync.run(org));
 });
 routes.get('/v1/organisations/:id/shopify/stock', async (c) => {
  const q = z.object({ belowReorder: z.enum(['true', 'false', '1', '0']).default('false'), offset: z.coerce.number().int().min(0).max(1_000_000).default(0) }).parse(c.req.query());
  return c.json(await reads.stock(actor(c), uuid.parse(c.req.param('id')), ['true', '1'].includes(q.belowReorder), q.offset));
 });
 routes.patch('/v1/organisations/:id/shopify/stock/:itemId', async (c) => { await reads.reorder(actor(c), uuid.parse(c.req.param('id')), uuid.parse(c.req.param('itemId')), await c.req.json()); return c.json({ ok: true }); });
 routes.get('/v1/organisations/:id/shopify/summary', async (c) => c.json(await reads.summary(actor(c), uuid.parse(c.req.param('id')))));
 return routes;
}
