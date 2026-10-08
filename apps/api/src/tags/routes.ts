import { Hono } from 'hono';
import { z } from 'zod';
import type { Session } from '../auth/service.ts';
import { badRequest } from '../errors.ts';
import { changeSetHeader } from '../changes.ts';
import { TagsService, workQuery } from './service.ts';
type Vars = { Variables: { requestId: string; session: Session } };
const uuid = z.string().uuid();
const pagination = z.object({ offset: z.coerce.number().int().min(0).max(1_000_000).default(0), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict();
async function readJson(req: { json(): Promise<unknown> }): Promise<unknown> {
 try { return await req.json(); }
 catch (error) { if (error instanceof SyntaxError) throw badRequest('invalid_request', 'The request body must be valid JSON.'); throw error; }
}
/** Tags and the Work list. Attaching a tag is a thread write (`POST/DELETE …/threads/:threadId/tags/:tagId`); the task
 *  tag routes of #135 are retired with task_tags (threads contract §5). */
export function tagsRoutes(service: TagsService) {
 const routes = new Hono<Vars>();
 const actor = (c: { get(key: 'session'): Session; get(key: 'requestId'): string }) => ({ userId: c.get('session').userId, requestId: c.get('requestId') });
 routes.get('/v1/organisations/:id/tags', async c => {
  const { offset, limit, counts } = pagination.extend({ counts: z.enum(['true', 'false']).optional() }).parse(c.req.query());
  return c.json(await service.list(actor(c), uuid.parse(c.req.param('id')), offset, limit, counts === 'true'));
 });
 routes.get('/v1/organisations/:id/tags/:tagId', async c => c.json(await service.one(actor(c), uuid.parse(c.req.param('id')), uuid.parse(c.req.param('tagId')))));
 const changed = <T extends { changeSetId: string }>(c: { header(name: string, value: string): void }, result: T) => { c.header(changeSetHeader, result.changeSetId); return result; };
 routes.post('/v1/organisations/:id/tags', async c => c.json(changed(c, await service.create(actor(c), uuid.parse(c.req.param('id')), await readJson(c.req))), 201));
 routes.patch('/v1/organisations/:id/tags/:tagId', async c => c.json(changed(c, await service.update(actor(c), uuid.parse(c.req.param('id')), uuid.parse(c.req.param('tagId')), await readJson(c.req)))));
 routes.get('/v1/organisations/:id/tasks/:taskId/tag-options', async c => {
  const { offset, limit } = pagination.parse(c.req.query());
  return c.json(await service.options(actor(c), uuid.parse(c.req.param('id')), uuid.parse(c.req.param('taskId')), offset, limit));
 });
 routes.get('/v1/organisations/:id/tasks', async c => {
  const { tagId: _, ...rest } = c.req.query();
  const query = workQuery.parse({ ...rest, tagIds: c.req.queries('tagId') ?? [] });
  return c.json(await service.work(actor(c), uuid.parse(c.req.param('id')), query));
 });
 return routes;
}
