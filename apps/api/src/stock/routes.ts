import { Hono } from 'hono';
import { z } from 'zod';
import type { Session } from '../auth/service.ts';
import { changeSetHeader } from '../changes.ts';
import type { StockService } from './service.ts';
export function stockRoutes(service: StockService) {
 const routes = new Hono<{ Variables: { requestId: string; session: Session } }>(); const uuid = z.string().uuid();
 const actor = (c: { get(key: 'session'): Session; get(key: 'requestId'): string }) => ({ userId: c.get('session').userId, requestId: c.get('requestId') });
 routes.get('/v1/organisations/:id/stock', async (c) => {
  const q = z.object({ location: z.string().trim().min(1).max(200).optional(), includeArchived: z.enum(['0', '1']).default('0') }).parse(c.req.query());
  return c.json(await service.list(actor(c), uuid.parse(c.req.param('id')), q.location, q.includeArchived === '1'));
 });
 const changed = <T extends { changeSetId: string }>(c: { header(name: string, value: string): void }, result: T) => { c.header(changeSetHeader, result.changeSetId); return result; };
 routes.post('/v1/organisations/:id/stock/stocktake', async (c) => c.json(changed(c, await service.stocktake(actor(c), uuid.parse(c.req.param('id')), await c.req.json())), 201));
 routes.get('/v1/organisations/:id/stock/:itemId', async (c) => c.json(await service.item(actor(c), uuid.parse(c.req.param('id')), uuid.parse(c.req.param('itemId')))));
 routes.post('/v1/organisations/:id/stock', async (c) => c.json(changed(c, await service.save(actor(c), uuid.parse(c.req.param('id')), await c.req.json())), 201));
 routes.patch('/v1/organisations/:id/stock/:itemId', async (c) => c.json(changed(c, await service.save(actor(c), uuid.parse(c.req.param('id')), await c.req.json(), uuid.parse(c.req.param('itemId'))))));
 routes.post('/v1/organisations/:id/stock/:itemId/count', async (c) => c.json(changed(c, await service.count(actor(c), uuid.parse(c.req.param('id')), uuid.parse(c.req.param('itemId')), await c.req.json())), 201));
 return routes;
}
