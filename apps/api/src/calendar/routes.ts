import { Hono } from 'hono';
import { z } from 'zod';
import type { Session } from '../auth/service.ts';
import type { CalendarService } from './service.ts';
type Vars = { Variables: { requestId: string; session: Session } };
export function calendarRoutes(calendar: CalendarService) {
 const routes = new Hono<Vars>(); const uuid = z.string().uuid();
 const date = z.union([z.string().date(), z.string().datetime({ offset: true })]);
 const actor = (c: { get(key: 'session'): Session; get(key: 'requestId'): string }) => ({ userId: c.get('session').userId, requestId: c.get('requestId') });
 routes.get('/v1/organisations/:id/calendar/calendars', async (c) => c.json(await calendar.read(actor(c), uuid.parse(c.req.param('id')))));
 routes.get('/v1/organisations/:id/calendar/events', async (c) => c.json(await calendar.read(actor(c), uuid.parse(c.req.param('id')), z.object({ from: date, to: date }).parse(c.req.query()))));
 routes.post('/v1/organisations/:id/calendar/sync', async (c) => c.json(await calendar.sync(actor(c), uuid.parse(c.req.param('id')))));
 return routes;
}
