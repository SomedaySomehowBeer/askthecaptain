import { Hono } from 'hono';
import { z } from 'zod';
import type { Session } from '../auth/service.ts';
import type { NotesService } from './service.ts';
export function notesRoutes(notes: NotesService) {
 const routes = new Hono<{ Variables: { requestId: string; session: Session } }>(); const uuid = z.uuid();
 const actor = (c: { get(key: 'session'): Session; get(key: 'requestId'): string }) => ({ userId: c.get('session').userId, requestId: c.get('requestId') });
 routes.get('/v1/organisations/:id/notes', async c => {
  const q = z.object({ limit: z.coerce.number().int().min(1).max(200).optional(), archived: z.enum(['true', 'false']).optional(), taskId: uuid.optional(), projectId: uuid.optional(), contactId: uuid.optional() }).parse(c.req.query());
  return c.json(await notes.list(actor(c), uuid.parse(c.req.param('id')), { ...q, archived: q.archived === 'true' }));
 });
 routes.post('/v1/organisations/:id/notes', async c => c.json(await notes.create(actor(c), uuid.parse(c.req.param('id')), await c.req.json()), 201));
 routes.get('/v1/organisations/:id/notes/:noteId', async c => c.json(await notes.get(actor(c), uuid.parse(c.req.param('id')), uuid.parse(c.req.param('noteId')))));
 routes.put('/v1/organisations/:id/notes/:noteId', async c => c.json(await notes.update(actor(c), uuid.parse(c.req.param('id')), uuid.parse(c.req.param('noteId')), await c.req.json())));
 routes.post('/v1/organisations/:id/notes/:noteId/archive', async c => c.json(await notes.archive(actor(c), uuid.parse(c.req.param('id')), uuid.parse(c.req.param('noteId')))));
 return routes;
}
