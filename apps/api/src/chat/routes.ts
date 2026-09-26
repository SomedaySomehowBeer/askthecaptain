import { Hono } from 'hono';
import { z } from 'zod';
import type { Session } from '../auth/service.ts';
import { badRequest } from '../errors.ts';
import { ChatService } from './service.ts';
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

/** Linked chat, PR B (contract §15): conversations, participants, task/project links and plain messages, under the
 *  signed-in router. Unknown, foreign and inaccessible ids all answer the same 404. */
export function chatRoutes(service: ChatService) {
 const routes = new Hono<Vars>();
 const actor = (c: { get(key: 'session'): Session; get(key: 'requestId'): string }) => ({ userId: c.get('session').userId, requestId: c.get('requestId') });
 const base = '/v1/organisations/:id/conversations';
 const one = `${base}/:conversationId`;

 routes.get(base, async c => c.json(await service.list(actor(c), uuid.parse(c.req.param('id')), singleQuery(c.req.queries()))));
 routes.post(base, async c => {
  const result = await service.create(actor(c), uuid.parse(c.req.param('id')), await readJson(c.req));
  return c.json(result.conversation, result.created ? 201 : 200);
 });
 routes.get(one, async c => c.json(await service.get(actor(c), uuid.parse(c.req.param('id')), uuid.parse(c.req.param('conversationId')))));
 routes.patch(one, async c => c.json(await service.rename(actor(c), uuid.parse(c.req.param('id')), uuid.parse(c.req.param('conversationId')), await readJson(c.req))));
 routes.post(`${one}/participants`, async c => c.json(await service.addParticipants(actor(c), uuid.parse(c.req.param('id')), uuid.parse(c.req.param('conversationId')), await readJson(c.req))));
 routes.delete(`${one}/participants/:userId`, async c => c.json(await service.removeParticipant(actor(c), uuid.parse(c.req.param('id')),
  uuid.parse(c.req.param('conversationId')), uuid.parse(c.req.param('userId')), singleQuery(c.req.queries()))));
 routes.post(`${one}/links`, async c => c.json(await service.addLink(actor(c), uuid.parse(c.req.param('id')), uuid.parse(c.req.param('conversationId')), await readJson(c.req)), 201));
 routes.delete(`${one}/links/:linkId`, async c => c.json(await service.removeLink(actor(c), uuid.parse(c.req.param('id')),
  uuid.parse(c.req.param('conversationId')), uuid.parse(c.req.param('linkId')), singleQuery(c.req.queries()))));
 routes.get(`${one}/messages`, async c => c.json(await service.messages(actor(c), uuid.parse(c.req.param('id')), uuid.parse(c.req.param('conversationId')), singleQuery(c.req.queries()))));
 routes.post(`${one}/messages`, async c => {
  const result = await service.send(actor(c), uuid.parse(c.req.param('id')), uuid.parse(c.req.param('conversationId')), await readJson(c.req));
  return c.json(result.message, result.created ? 201 : 200);
 });
 routes.delete(`${one}/messages/:messageId`, async c => c.json(await service.deleteMessage(actor(c), uuid.parse(c.req.param('id')),
  uuid.parse(c.req.param('conversationId')), uuid.parse(c.req.param('messageId')), singleQuery(c.req.queries()))));
 // PR C (contract §13): author edits, shared pins, personal stars and read positions. Every write here is a POST, PATCH
 // or DELETE under the conversations path, so the existing chat-writes limit applies; nothing relaxes it.
 routes.patch(`${one}/messages/:messageId`, async c => c.json(await service.editMessage(actor(c), uuid.parse(c.req.param('id')),
  uuid.parse(c.req.param('conversationId')), uuid.parse(c.req.param('messageId')), await readJson(c.req))));
 routes.get(`${one}/pins`, async c => c.json(await service.pins(actor(c), uuid.parse(c.req.param('id')), uuid.parse(c.req.param('conversationId')))));
 routes.post(`${one}/pins`, async c => c.json(await service.pin(actor(c), uuid.parse(c.req.param('id')), uuid.parse(c.req.param('conversationId')), await readJson(c.req)), 201));
 routes.delete(`${one}/pins/:pinId`, async c => c.json(await service.unpin(actor(c), uuid.parse(c.req.param('id')),
  uuid.parse(c.req.param('conversationId')), uuid.parse(c.req.param('pinId')))));
 routes.post(`${one}/star`, async c => c.json(await service.setStar(actor(c), uuid.parse(c.req.param('id')), uuid.parse(c.req.param('conversationId')), true)));
 routes.delete(`${one}/star`, async c => c.json(await service.setStar(actor(c), uuid.parse(c.req.param('id')), uuid.parse(c.req.param('conversationId')), false)));
 routes.post(`${one}/read`, async c => c.json(await service.markRead(actor(c), uuid.parse(c.req.param('id')), uuid.parse(c.req.param('conversationId')), await readJson(c.req))));
 routes.get(`${one}/changes`, async c => c.json(await service.changes(actor(c), uuid.parse(c.req.param('id')), uuid.parse(c.req.param('conversationId')), singleQuery(c.req.queries()))));
 // Work to chat: only the caller's own conversations; work payloads themselves gain no chat fields.
 routes.get('/v1/organisations/:id/tasks/:taskId/conversations', async c =>
  c.json(await service.forTarget(actor(c), uuid.parse(c.req.param('id')), 'task', uuid.parse(c.req.param('taskId')))));
 routes.get('/v1/organisations/:id/projects/:projectId/conversations', async c =>
  c.json(await service.forTarget(actor(c), uuid.parse(c.req.param('id')), 'project', uuid.parse(c.req.param('projectId')))));
 return routes;
}
