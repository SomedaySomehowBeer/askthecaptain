import { Hono } from 'hono';
import { z } from 'zod';
import type { Session } from '../auth/service.ts';
import { badRequest } from '../errors.ts';
import { TagsService, workQuery } from './service.ts';
type Vars = { Variables: { requestId: string; session: Session } };
const uuid = z.string().uuid();
const pagination = workQuery.pick({ offset: true, limit: true });
async function readJson(req: { json(): Promise<unknown> }): Promise<unknown> {
 try { return await req.json(); }
 catch (error) { if (error instanceof SyntaxError) throw badRequest('invalid_request', 'The request body must be valid JSON.'); throw error; }
}
export function tagsRoutes(service: TagsService) {
 const routes = new Hono<Vars>();
 const actor = (c: { get(key: 'session'): Session; get(key: 'requestId'): string }) => ({ userId: c.get('session').userId, requestId: c.get('requestId') });
 routes.get('/v1/organisations/:id/tags', async c => {
  const { offset, limit } = pagination.parse(c.req.query());
  return c.json(await service.list(actor(c), uuid.parse(c.req.param('id')), offset, limit));
 });
 routes.post('/v1/organisations/:id/tags', async c => c.json(await service.save(actor(c), uuid.parse(c.req.param('id')), await readJson(c.req)), 201));
 routes.patch('/v1/organisations/:id/tags/:tagId', async c => c.json(await service.save(actor(c), uuid.parse(c.req.param('id')), await readJson(c.req), uuid.parse(c.req.param('tagId')))));
 routes.get('/v1/organisations/:id/tasks/:taskId/tag-options', async c => {
  const { offset, limit } = pagination.parse(c.req.query());
  return c.json(await service.options(actor(c), uuid.parse(c.req.param('id')), uuid.parse(c.req.param('taskId')), offset, limit));
 });
 for (const method of ['put', 'delete'] as const) routes[method]('/v1/organisations/:id/tasks/:taskId/tags/:tagId', async c =>
  c.json(await service.setLink(actor(c), uuid.parse(c.req.param('id')), uuid.parse(c.req.param('taskId')), uuid.parse(c.req.param('tagId')), method === 'put')));
 routes.get('/v1/organisations/:id/tasks', async c => {
  const query = workQuery.parse({ ...c.req.query(), tagIds: c.req.queries('tagId') ?? [] });
  return c.json(await service.work(actor(c), uuid.parse(c.req.param('id')), query));
 });
 return routes;
}
