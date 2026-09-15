import { mailRoutes } from './mail/routes.ts';
import { MailService } from './mail/service.ts';
import type { MailSync } from './mail/sync.ts';
import { connectionRoutes } from './connections/routes.ts';
import type { ConnectionService } from './connections/service.ts';
import { randomUUID } from 'node:crypto';
import type { Sql } from '@captain/db';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthService, Session } from './auth/service.ts';
import { commitmentsRoutes } from './commitments/routes.ts';
import type { CommitmentsService } from './commitments/service.ts';
import { HttpError, unauthorised } from './errors.ts';
import type { OrganisationService } from './organisations/service.ts';

export type Deps = { db: Sql; auth: AuthService; organisations: OrganisationService; commitments: CommitmentsService; connections?: ConnectionService; mailSync?: MailSync; mailScheduleEnabled?: boolean };
type Vars = { Variables: { requestId: string; session: Session } };

const bearer = (header: string | undefined) => /^Bearer (sess_[A-Za-z0-9_-]+)$/.exec(header ?? '')?.[1];
const uuid = z.string().uuid();
const role = z.enum(['owner', 'admin', 'member']);

/** The HTTP surface. Routes parse and check, services decide and write. Sessions arrive as a
 *  bearer token from the web app, which owns the cookie. */
export function createApp(deps: Deps) {
	const app = new Hono<Vars>();

	app.use('*', async (c, next) => {
		c.set('requestId', c.req.header('x-request-id') ?? randomUUID());
		await next();
		c.header('x-request-id', c.get('requestId'));
		c.header('cache-control', 'no-store');
	});

	app.get('/healthz', (c) => c.json({ ok: true }));
	app.get('/readyz', async (c) => {
		try { await deps.db`select 1`; return c.json({ ok: true }); } catch { return c.json({ ok: false, reason: 'database unreachable' }, 503); }
	});

	// Sign-in. The web sends people here; Google returns here; the web gets a one-time code.
	app.get('/auth/google/start', async (c) => c.redirect(await deps.auth.startGoogle(c.get('requestId'), c.req.query('return_to'))));
	app.get('/auth/google/callback', async (c) => c.redirect((await deps.auth.finishGoogle(c.req.query('code') ?? '', c.req.query('state') ?? '', c.get('requestId'))).toString()));
	app.post('/auth/session/exchange', async (c) => {
		const input = z.object({ code: z.string().min(1) }).parse(await c.req.json());
		const { token, session, returnTo } = await deps.auth.exchange(input.code, c.get('requestId'));
		return c.json({ token, expiresAt: session.expiresAt, user: session.user, returnTo });
	});
	app.get('/auth/providers', (c) => c.json({ google: deps.auth.googleAvailable }));

	app.route('/', connectionRoutes(deps));

	const signedIn = new Hono<Vars>();
	signedIn.use('*', async (c, next) => {
		const token = bearer(c.req.header('authorization')); if (!token) throw unauthorised();
		c.set('session', await deps.auth.requireSession(token)); await next();
	});
	const actor = (c: { get(key: 'session'): Session; get(key: 'requestId'): string }) => ({ userId: c.get('session').userId, requestId: c.get('requestId') });

	signedIn.post('/auth/sign-out', async (c) => { await deps.auth.signOut(bearer(c.req.header('authorization')), c.get('requestId')); return c.json({ ok: true }); });
	signedIn.get('/v1/me', async (c) => c.json({ user: c.get('session').user, memberships: await deps.organisations.memberships(c.get('session').userId) }));

	signedIn.post('/v1/organisations', async (c) => {
		const input = z.object({ name: z.string().trim().min(1).max(120), timezone: z.string().min(1).max(64).optional() }).parse(await c.req.json());
		return c.json(await deps.organisations.create(actor(c), input), 201);
	});
	signedIn.get('/v1/organisations/:id', async (c) => c.json(await deps.organisations.get(actor(c), uuid.parse(c.req.param('id')))));
	signedIn.patch('/v1/organisations/:id', async (c) => {
		const input = z.object({ name: z.string().trim().min(1).max(120).optional(), timezone: z.string().min(1).max(64).optional() }).parse(await c.req.json());
		return c.json(await deps.organisations.update(actor(c), uuid.parse(c.req.param('id')), input));
	});
	signedIn.get('/v1/organisations/:id/members', async (c) => c.json({ members: await deps.organisations.members(actor(c), uuid.parse(c.req.param('id'))) }));
	signedIn.patch('/v1/organisations/:id/members/:userId', async (c) => {
		const input = z.object({ role }).parse(await c.req.json());
		await deps.organisations.setRole(actor(c), uuid.parse(c.req.param('id')), uuid.parse(c.req.param('userId')), input.role); return c.json({ ok: true });
	});
	signedIn.delete('/v1/organisations/:id/members/:userId', async (c) => {
		await deps.organisations.remove(actor(c), uuid.parse(c.req.param('id')), uuid.parse(c.req.param('userId'))); return c.json({ ok: true });
	});
	signedIn.get('/v1/organisations/:id/invitations', async (c) => c.json({ invitations: await deps.organisations.invitations(actor(c), uuid.parse(c.req.param('id'))) }));
	signedIn.post('/v1/organisations/:id/invitations', async (c) => {
		const input = z.object({ email: z.string().email(), role: z.enum(['admin', 'member']) }).parse(await c.req.json());
		return c.json(await deps.organisations.invite(actor(c), uuid.parse(c.req.param('id')), input), 201);
	});
	signedIn.delete('/v1/organisations/:id/invitations/:invitationId', async (c) => {
		await deps.organisations.revokeInvitation(actor(c), uuid.parse(c.req.param('id')), uuid.parse(c.req.param('invitationId'))); return c.json({ ok: true });
	});
	signedIn.post('/v1/invitations/accept', async (c) => {
		const input = z.object({ token: z.string().min(1) }).parse(await c.req.json());
		return c.json(await deps.organisations.accept({ ...actor(c), email: c.get('session').user.email }, input.token));
	});
	signedIn.route('/', commitmentsRoutes(deps.commitments));
	signedIn.route('/', mailRoutes(new MailService(deps.db, deps.mailSync, deps.mailScheduleEnabled)));
	app.route('/', signedIn);

	app.notFound((c) => c.json({ ok: false, code: 'not_found', error: 'not found' }, 404));
	app.onError((error, c) => {
		if (error instanceof HttpError) return c.json({ ok: false, code: error.code, error: error.message }, error.status as 400);
		if (error instanceof z.ZodError) return c.json({ ok: false, code: 'invalid_request', error: 'the request was not understood' }, 400);
		console.error(`[${c.get('requestId')}]`, error);
		return c.json({ ok: false, code: 'internal', error: 'something went wrong on our side' }, 500);
	});
	return app;
}
