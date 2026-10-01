import { Hono } from 'hono';
import { z } from 'zod';
import type { Session } from '../auth/service.ts';
import { badRequest } from '../errors.ts';
import { ThreadsService } from './service.ts';
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

/** Threads (contract `docs/plans/threads-2026-09.md` §5, §6), under the signed-in router. They replace
 *  `…/conversations…`; unknown, foreign and inaccessible ids all answer the same 404. Every write is a POST, PATCH or
 *  DELETE under `…/threads`, so the `chat changes` rate limit applies to all of them. */
export function threadsRoutes(service: ThreadsService) {
 const routes = new Hono<Vars>();
 const actor = (c: { get(key: 'session'): Session; get(key: 'requestId'): string }) => ({ userId: c.get('session').userId, requestId: c.get('requestId') });
 const base = '/v1/organisations/:id/threads';
 const one = `${base}/:threadId`;
 const org = (c: { req: { param(name: 'id'): string } }) => uuid.parse(c.req.param('id'));
 const thread = (c: { req: { param(name: 'threadId'): string } }) => uuid.parse(c.req.param('threadId'));

 routes.get(base, async c => c.json(await service.list(actor(c), org(c), singleQuery(c.req.queries()))));
 routes.post(base, async c => {
  const result = await service.create(actor(c), org(c), await readJson(c.req));
  return c.json(result.thread, result.created ? 201 : 200);
 });
 routes.get(one, async c => c.json(await service.get(actor(c), org(c), thread(c))));
 routes.patch(one, async c => c.json(await service.rename(actor(c), org(c), thread(c), await readJson(c.req))));
 routes.post(`${one}/participants`, async c => c.json(await service.addParticipants(actor(c), org(c), thread(c), await readJson(c.req))));
 routes.delete(`${one}/participants/:userId`, async c => c.json(await service.removeParticipant(actor(c), org(c), thread(c),
  uuid.parse(c.req.param('userId')), singleQuery(c.req.queries()))));
 routes.post(`${one}/tags/:tagId`, async c => c.json(await service.setTag(actor(c), org(c), thread(c), uuid.parse(c.req.param('tagId')), true, await readJson(c.req))));
 routes.delete(`${one}/tags/:tagId`, async c => c.json(await service.setTag(actor(c), org(c), thread(c), uuid.parse(c.req.param('tagId')), false, singleQuery(c.req.queries()))));
 routes.get(`${one}/messages`, async c => c.json(await service.messages(actor(c), org(c), thread(c), singleQuery(c.req.queries()))));
 routes.post(`${one}/messages`, async c => {
  const result = await service.send(actor(c), org(c), thread(c), await readJson(c.req));
  return c.json(result.message, result.created ? 201 : 200);
 });
 routes.patch(`${one}/messages/:messageId`, async c => c.json(await service.editMessage(actor(c), org(c), thread(c), uuid.parse(c.req.param('messageId')), await readJson(c.req))));
 routes.delete(`${one}/messages/:messageId`, async c => c.json(await service.deleteMessage(actor(c), org(c), thread(c),
  uuid.parse(c.req.param('messageId')), singleQuery(c.req.queries()))));
 // One pin per thread (§6): set it, or clear it. `GET …/pins` is retired; detail carries the pin.
 routes.post(`${one}/pin`, async c => c.json(await service.pin(actor(c), org(c), thread(c), await readJson(c.req)), 201));
 routes.delete(`${one}/pin`, async c => c.json(await service.unpin(actor(c), org(c), thread(c))));
 routes.post(`${one}/star`, async c => c.json(await service.setStar(actor(c), org(c), thread(c), true)));
 routes.delete(`${one}/star`, async c => c.json(await service.setStar(actor(c), org(c), thread(c), false)));
 routes.post(`${one}/read`, async c => c.json(await service.markRead(actor(c), org(c), thread(c), await readJson(c.req))));
 routes.get(`${one}/changes`, async c => c.json(await service.changes(actor(c), org(c), thread(c), singleQuery(c.req.queries()))));
 return routes;
}
