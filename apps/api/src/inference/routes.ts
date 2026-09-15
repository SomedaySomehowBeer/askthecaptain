import { Hono } from 'hono';
import { z } from 'zod';
import type { Session } from '../auth/service.ts';
import { badRequest, HttpError } from '../errors.ts';
import { inferenceHttpError, type InferenceService } from './service.ts';
const uuid = z.string().uuid();
const loginUrl = z.string().url().refine(value => { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.port && ['claude.ai', 'platform.claude.com', 'auth.openai.com'].includes(u.hostname); });
export function inferenceRoutes(service?: InferenceService) {
 const routes = new Hono<{ Variables: { session: Session; requestId: string } }>();
 routes.onError((error, c) => {
  try { inferenceHttpError(error); } catch (mapped) { if (mapped instanceof HttpError) return c.json({ ok: false, code: mapped.code, error: mapped.message }, mapped.status as 400); throw mapped; }
 });
 const requireService = () => { if (!service) throw badRequest('runtime_not_ready', 'Inference is disabled. Ask the operator to configure it.'); return service; };
 const actor = (c: { get(key: 'session'): Session; get(key: 'requestId'): string }) => ({ userId: c.get('session').userId, requestId: c.get('requestId') });
 routes.get('/v1/organisations/:id/inference', async c => c.json(await requireService().get(actor(c), uuid.parse(c.req.param('id')))));
 routes.post('/v1/organisations/:id/inference/runtime', async c => c.json(await requireService().request(actor(c), uuid.parse(c.req.param('id')), z.object({ provider: z.enum(['claude', 'codex']) }).strict().parse(await c.req.json()).provider), 201));
 // Owner-run script attaches its generated secret; never returned by a read route.
 routes.post('/v1/organisations/:id/inference/runtime/configure', async c => {
  const input = z.object({ url: z.string().url(), secret: z.string().regex(/^[a-f0-9]{64}$/), spriteName: z.string().regex(/^[a-z0-9-]{1,63}$/), region: z.string().min(1).max(64), loginHint: z.string().email().max(254).nullable(), loginUrl: loginUrl.nullable() }).strict().parse(await c.req.json());
  await requireService().configure(actor(c), uuid.parse(c.req.param('id')), input); return c.json({ ok: true });
 });
 routes.post('/v1/organisations/:id/inference/runtime/verify', async c => { await requireService().verify(actor(c), uuid.parse(c.req.param('id'))); return c.json({ ok: true }); });
 routes.delete('/v1/organisations/:id/inference/runtime', async c => c.json(await requireService().remove(actor(c), uuid.parse(c.req.param('id')))));
 routes.patch('/v1/organisations/:id/inference/budget', async c => {
  const input = z.object({ limitTokens: z.number().int().nonnegative().safe() }).strict().parse(await c.req.json());
  await requireService().setBudget(actor(c), uuid.parse(c.req.param('id')), input.limitTokens); return c.json({ ok: true });
 });
 return routes;
}
