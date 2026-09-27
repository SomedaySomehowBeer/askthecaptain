import type { Sql } from '@captain/db';
import { roleOf } from '../tenant.ts';
import { legacyRetired } from '../retirement/routes.ts';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthService, Session } from '../auth/service.ts';
import { unauthorised } from '../errors.ts';

/** The retired Google mail/calendar connection routes (#133). Captain keeps no Google mailbox grant path: these
 *  answer 410 so an old link or client is told plainly. The organisation-scoped start keeps its bearer and
 *  membership checks, so it never tells a stranger whether an organisation exists. Google sign-in is separate
 *  (`/auth/google/*`) and unaffected. */
type Vars = { Variables: { requestId: string; session: Session } };
export function connectionRoutes(deps: { db: Sql; auth: AuthService }) {
	const routes = new Hono<Vars>(); const uuid = z.string().uuid();
	routes.get('/connections/google/callback', () => { throw legacyRetired(); });

	routes.use('/v1/organisations/:id/connections/*', async (c, next) => {
		const token = /^Bearer (sess_[A-Za-z0-9_-]+)$/.exec(c.req.header('authorization') ?? '')?.[1];
		if (!token) throw unauthorised();
		c.set('session', await deps.auth.requireSession(token)); await next();
	});
	routes.post('/v1/organisations/:id/connections/google/start', async c => { await roleOf(deps.db, c.get('session').userId, uuid.parse(c.req.param('id'))); throw legacyRetired(); });
	return routes;
}
