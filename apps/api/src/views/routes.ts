import { Hono } from 'hono';
import { z } from 'zod';
import type { Session } from '../auth/service.ts';
import { badRequest } from '../errors.ts';
import { SavedViewsService } from './service.ts';
type Vars = { Variables: { requestId: string; session: Session } };
const uuid = z.string().uuid().transform(value => value.toLowerCase());
function singleQuery(values: Record<string, string[]>): Record<string, string> {
 const query: Record<string, string> = {};
 for (const [key, entries] of Object.entries(values)) {
  if (entries.length !== 1) throw badRequest('invalid_request', 'Each query parameter must be supplied only once.');
  query[key] = entries[0]!;
 }
 return query;
}
async function readJson(req: { json(): Promise<unknown> }): Promise<unknown> {
 try { return await req.json(); }
 catch (error) { if (error instanceof SyntaxError) throw badRequest('invalid_request', 'The request body must be valid JSON.'); throw error; }
}
/** Private saved Work views (D26): the caller's own views only, under the signed-in router. */
export function savedViewsRoutes(service: SavedViewsService) {
 const routes = new Hono<Vars>();
 const actor = (c: { get(key: 'session'): Session; get(key: 'requestId'): string }) => ({ userId: c.get('session').userId, requestId: c.get('requestId') });
 const base = '/v1/organisations/:id/views';
 routes.get(base, async c => c.json(await service.list(actor(c), uuid.parse(c.req.param('id')), singleQuery(c.req.queries()))));
 routes.post(base, async c => {
  const result = await service.create(actor(c), uuid.parse(c.req.param('id')), await readJson(c.req));
  return c.json(result.view, result.created ? 201 : 200);
 });
 routes.get(`${base}/:viewId`, async c => c.json(await service.get(actor(c), uuid.parse(c.req.param('id')), uuid.parse(c.req.param('viewId')))));
 routes.patch(`${base}/:viewId`, async c => c.json(await service.update(actor(c), uuid.parse(c.req.param('id')), uuid.parse(c.req.param('viewId')), await readJson(c.req))));
 routes.delete(`${base}/:viewId`, async c => c.json(await service.remove(actor(c), uuid.parse(c.req.param('id')), uuid.parse(c.req.param('viewId')), singleQuery(c.req.queries()))));
 return routes;
}
