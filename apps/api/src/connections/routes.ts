import type { Sql } from '@captain/db';
import { roleOf } from '../tenant.ts';
import { legacyRetired } from '../retirement/routes.ts';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthService, Session } from '../auth/service.ts';
import { badRequest, unauthorised } from '../errors.ts';
import type { ConnectionService } from './service.ts';

type Vars = { Variables: { requestId: string; session: Session } };
export function connectionRoutes(deps: { db: Sql; auth: AuthService; connections?: ConnectionService }) {
	const routes = new Hono<Vars>(); const uuid = z.string().uuid();
	const service = () => { if (!deps.connections) throw badRequest('google_unavailable', 'Google connections are not configured.'); return deps.connections; };
	routes.get('/connections/google/callback', () => { throw legacyRetired(); });

	routes.use('/v1/organisations/:id/connections/*', async (c, next) => {
		const token = /^Bearer (sess_[A-Za-z0-9_-]+)$/.exec(c.req.header('authorization') ?? '')?.[1];
		if (!token) throw unauthorised();
		c.set('session', await deps.auth.requireSession(token)); await next();
	});
	const actor = (c: { get(key: 'session'): Session; get(key: 'requestId'): string }) => ({ userId: c.get('session').userId, requestId: c.get('requestId') });
	routes.get('/v1/organisations/:id/connections', async (c) => c.json({ ...await service().list(actor(c), uuid.parse(c.req.param('id'))), googleAvailable: false }));
	routes.post('/v1/organisations/:id/connections/google/start', async c => { await roleOf(deps.db, actor(c).userId, uuid.parse(c.req.param('id'))); throw legacyRetired(); });
	routes.delete('/v1/organisations/:id/connections/:connectionId', async (c) => {
		await service().disconnect(actor(c), uuid.parse(c.req.param('id')), uuid.parse(c.req.param('connectionId'))); return c.json({ ok: true });
	});
	return routes;
}
