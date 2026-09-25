import { Hono } from 'hono';
import { z } from 'zod';
import type { Session } from '../auth/service.ts';
import { badRequest } from '../errors.ts';
import { EquipmentService } from './service.ts';
type Vars = { Variables: { requestId: string; session: Session } };
const uuid = z.string().uuid().transform(value => value.toLowerCase());
async function readJson(req: { json(): Promise<unknown> }): Promise<unknown> {
 try { return await req.json(); }
 catch (error) { if (error instanceof SyntaxError) throw badRequest('invalid_request', 'The request body must be valid JSON.'); throw error; }
}
export function equipmentRoutes(service: EquipmentService) {
 const routes = new Hono<Vars>();
 const actor = (c: { get(key: 'session'): Session; get(key: 'requestId'): string }) => ({ userId: c.get('session').userId, requestId: c.get('requestId') });
 const base = '/v1/organisations/:id/equipment';
 routes.get(base, async c => c.json(await service.list(actor(c), uuid.parse(c.req.param('id')), c.req.query())));
 routes.post(base, async c => c.json(await service.create(actor(c), uuid.parse(c.req.param('id')), await readJson(c.req)), 201));
 routes.get(`${base}/:equipmentId`, async c => c.json(await service.get(actor(c), uuid.parse(c.req.param('id')), uuid.parse(c.req.param('equipmentId')))));
 routes.patch(`${base}/:equipmentId`, async c => c.json(await service.update(actor(c), uuid.parse(c.req.param('id')), uuid.parse(c.req.param('equipmentId')), await readJson(c.req))));
 routes.get(`${base}/:equipmentId/reservations`, async c => c.json(await service.reservations(actor(c), uuid.parse(c.req.param('id')), uuid.parse(c.req.param('equipmentId')), c.req.query())));
 routes.get(`${base}/:equipmentId/reservations/:reservationId`, async c => c.json(await service.getBooking(actor(c), uuid.parse(c.req.param('id')), uuid.parse(c.req.param('equipmentId')), uuid.parse(c.req.param('reservationId')))));
 routes.post(`${base}/:equipmentId/reservations`, async c => {
  const result = await service.createBooking(actor(c), uuid.parse(c.req.param('id')), uuid.parse(c.req.param('equipmentId')), await readJson(c.req));
  return c.json(result.reservation, result.created ? 201 : 200);
 });
 routes.patch(`${base}/:equipmentId/reservations/:reservationId`, async c => c.json(await service.replaceBooking(actor(c), uuid.parse(c.req.param('id')), uuid.parse(c.req.param('equipmentId')), uuid.parse(c.req.param('reservationId')), await readJson(c.req))));
 routes.post(`${base}/:equipmentId/reservations/:reservationId/cancel`, async c => c.json(await service.cancelBooking(actor(c), uuid.parse(c.req.param('id')), uuid.parse(c.req.param('equipmentId')), uuid.parse(c.req.param('reservationId')), await readJson(c.req))));
 routes.get('/v1/organisations/:id/projects/:projectId/reservations', async c => c.json(await service.projectReservations(actor(c), uuid.parse(c.req.param('id')), uuid.parse(c.req.param('projectId')), c.req.query())));
 return routes;
}
