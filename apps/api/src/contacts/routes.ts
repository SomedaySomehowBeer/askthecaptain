import { Hono } from 'hono';
import { z } from 'zod';
import type { Session } from '../auth/service.ts';
import type { ContactsService } from './service.ts';
const uuid = z.string().uuid(); const text = (max: number) => z.string().trim().max(max);
const contact = z.object({ name: text(200).optional(), email: text(254).email(), companyId: uuid.nullable().optional(),
 phone: text(80).optional(), role: text(200).optional(), notes: text(5000).optional(), archived: z.boolean().optional() }).strict();
const company = z.object({ name: text(200).min(1), domain: text(253).regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i).nullable().optional(),
 notes: text(5000).optional(), archived: z.boolean().optional() }).strict();
const query = z.object({ q: text(200).default(''), limit: z.coerce.number().int().min(1).max(200).default(100) });
export function contactsRoutes(service: ContactsService) {
 const routes = new Hono<{ Variables: { requestId: string; session: Session } }>();
 const actor = (c: { get(key: 'session'): Session; get(key: 'requestId'): string }) => ({ userId: c.get('session').userId, requestId: c.get('requestId') });
 routes.get('/v1/organisations/:id/contacts', async (c) => { const q = query.parse(c.req.query()); return c.json(await service.list(actor(c), uuid.parse(c.req.param('id')), q.q, q.limit)); });
 routes.get('/v1/organisations/:id/contacts/:contactId', async (c) => c.json(await service.detail(actor(c), uuid.parse(c.req.param('id')), uuid.parse(c.req.param('contactId')))));
 routes.post('/v1/organisations/:id/contacts', async (c) => c.json(await service.saveContact(actor(c), uuid.parse(c.req.param('id')), contact.parse(await c.req.json())), 201));
 routes.patch('/v1/organisations/:id/contacts/:contactId', async (c) => c.json(await service.saveContact(actor(c), uuid.parse(c.req.param('id')), contact.partial().parse(await c.req.json()), uuid.parse(c.req.param('contactId')))));
 routes.get('/v1/organisations/:id/companies', async (c) => { const q = query.parse(c.req.query()); return c.json(await service.companies(actor(c), uuid.parse(c.req.param('id')), q.q, q.limit)); });
 routes.post('/v1/organisations/:id/companies', async (c) => c.json(await service.saveCompany(actor(c), uuid.parse(c.req.param('id')), company.parse(await c.req.json())), 201));
 routes.patch('/v1/organisations/:id/companies/:companyId', async (c) => c.json(await service.saveCompany(actor(c), uuid.parse(c.req.param('id')), company.partial().parse(await c.req.json()), uuid.parse(c.req.param('companyId')))));
 return routes;
}
