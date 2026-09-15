import { Hono } from 'hono';
import { z } from 'zod';
import type { Session } from '../auth/service.ts';
import { RateLimited } from '../ratelimit.ts';
import { AnswerService, questionSchema } from './service.ts';
export function answerRoutes(service: AnswerService) {
 const routes = new Hono<{ Variables: { session: Session; requestId: string } }>();
 const path = '/v1/organisations/:id/answers';
 routes.get(path, async c => c.json(await service.list({ userId: c.get('session').userId, requestId: c.get('requestId') }, z.uuid().parse(c.req.param('id')), z.coerce.number().int().min(1).max(10).parse(c.req.query('limit') ?? 3))));
 routes.post(path, async c => {
  const { question } = z.object({ question: questionSchema }).strict().parse(await c.req.json());
  try { return c.json(await service.ask({ userId: c.get('session').userId, requestId: c.get('requestId') }, z.uuid().parse(c.req.param('id')), question), 201); }
  catch (error) { if (error instanceof RateLimited) c.header('retry-after', String(error.retryAfterSeconds)); throw error; }
 });
 return routes;
}
