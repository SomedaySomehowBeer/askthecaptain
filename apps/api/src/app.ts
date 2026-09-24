import { TagsService } from './tags/service.ts';
import { tagsRoutes } from './tags/routes.ts';
import { AnswerService } from './answers/service.ts';
import { answerRoutes } from './answers/routes.ts';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { shopifyRoutes } from './shopify/routes.ts';
import type { ShopifyConnections } from './shopify/connections.ts';
import type { ShopifySync } from './shopify/sync.ts';
import { BriefService } from './briefs/service.ts';
import { StockService } from './stock/service.ts';
import { stockRoutes } from './stock/routes.ts';
import { outboxRoutes, threadRoutes } from './triage/routes.ts';
import { discoveryRoutes } from './discovery/routes.ts';
import type { DiscoveryService } from './discovery/service.ts';
import type { TriageService } from './triage/service.ts';
import { notesRoutes } from './notes/routes.ts';
import type { NotesService } from './notes/service.ts';
import type { OutboxService } from './triage/outbox.ts';
import { xeroRoutes } from './xero/routes.ts';
import type { XeroConnections } from './xero/connections.ts';
import type { XeroSync } from './xero/sync.ts';
import { gmailPushRoutes, type GmailPush } from './mail/push.ts';
import type { GmailWatch } from './mail/watch.ts';
import { contactsRoutes } from './contacts/routes.ts';
import { ContactsService } from './contacts/service.ts';
import { calendarRoutes } from './calendar/routes.ts';
import { CalendarService } from './calendar/service.ts';
import type { CalendarSync } from './calendar/sync.ts';
import { inferenceRoutes } from './inference/routes.ts';
import type { InferenceService } from './inference/service.ts';
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
import type { OrganisationLifecycle } from './organisations/lifecycle.ts';
import type { PasskeyService } from './auth/passkeys.ts';
import { RateLimiter, policies, rateLimit } from './ratelimit.ts';
import type { OrganisationService } from './organisations/service.ts';
import { pushRoutes } from './push/routes.ts';
import type { PushService } from './push/service.ts';
import { workflowRoutes } from './workflows/routes.ts';
import type { WorkflowService } from './workflows/service.ts';

export type Deps = { discovery?: DiscoveryService; stock?: StockService; shopifyConnections?: ShopifyConnections; shopifySync?: ShopifySync; shopifyScheduleEnabled?: boolean; outbox?: OutboxService; triage?: TriageService; notes?: NotesService; inference?: InferenceService; db: Sql; xeroConnections?: XeroConnections; xeroSync?: XeroSync; xeroScheduleEnabled?: boolean; auth: AuthService; organisations: OrganisationService; commitments: CommitmentsService; connections?: ConnectionService; mailSync?: MailSync; gmailPush?: GmailPush; gmailWatch?: GmailWatch; mailScheduleEnabled?: boolean; calendarSync?: CalendarSync; calendarScheduleEnabled?: boolean; workflows?: WorkflowService ; push?: PushService ; rateLimiter?: RateLimiter ; lifecycle?: OrganisationLifecycle ; passkeys?: PasskeyService };
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

	// Rate limits (plan §9): per address before sign-in, per person and organisation after, and a
	// small budget for the triggers that reach a provider. Health checks are never limited.
	const limiter = deps.rateLimiter ?? new RateLimiter(); const limits = policies();
	app.use('/auth/*', rateLimit(limiter, limits.auth));
	app.use('/connections/*', rateLimit(limiter, limits.auth));
	app.use('/webhooks/*', rateLimit(limiter, limits.webhook));
	app.use('/v1/*', rateLimit(limiter, limits.ip));

	app.get('/healthz', (c) => c.json({ ok: true }));
	app.get('/readyz', async (c) => {
		try { await deps.db`select 1`; return c.json({ ok: true }); } catch { return c.json({ ok: false, reason: 'database unreachable' }, 503); }
	});

	// Sign-in. The web sends people here; Google returns here; the web gets a one-time code.
	app.get('/auth/google/start', async (c) => c.redirect(await deps.auth.startGoogle(c.get('requestId'), c.req.query('return_to'))));
	app.get('/auth/google/callback', async (c) => c.redirect((await deps.auth.finishGoogle(c.req.query('code') ?? '', c.req.query('state') ?? '', c.get('requestId'))).toString()));
	app.post('/auth/session/exchange', async (c) => {
		const input = z.object({ code: z.string().min(1) }).parse(await c.req.json());
		const result = await deps.auth.exchange(input.code, c.get('requestId'));
		if ('stepUp' in result) return c.json({ stepUp: true, token: result.token, returnTo: result.returnTo });
		return c.json({ token: result.token, expiresAt: result.session.expiresAt, user: result.session.user, returnTo: result.returnTo });
	});
	// Passkey step-up between the Google sign-in and the session (plan §9).
	app.post('/auth/passkey/options', async (c) => {
		if (!deps.passkeys) throw unauthorised('passkeys are not available');
		const input = z.object({ token: z.string().min(1) }).parse(await c.req.json());
		return c.json({ options: await deps.passkeys.stepUpOptions(input.token) });
	});
	app.post('/auth/passkey/verify', async (c) => {
		const input = z.object({ token: z.string().min(1), response: z.unknown() }).parse(await c.req.json());
		const { token, session, returnTo } = await deps.auth.completeStepUp(input.token, input.response, c.get('requestId'));
		return c.json({ token, expiresAt: session.expiresAt, user: session.user, returnTo });
	});
	app.get('/auth/providers', (c) => c.json({ google: deps.auth.googleAvailable }));

	app.get('/connections/shopify/authorize', async (c) => {
  if (!deps.shopifyConnections) throw new HttpError(503, 'shopify_unavailable', 'Shopify connections are not configured.');
  const state = c.req.query('state') ?? ''; const url = await deps.shopifyConnections.authorize(state);
  setCookie(c, 'captain_shopify_state', state, { httpOnly: true, secure: deps.shopifyConnections.client!.redirectUri.startsWith('https:'), sameSite: 'Lax', path: '/connections/shopify', maxAge: 900 });
  c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'no-referrer'); return c.redirect(url);
 });
 app.get('/connections/shopify/callback', async (c) => {
  if (!deps.shopifyConnections) throw new HttpError(503, 'shopify_unavailable', 'Shopify connections are not configured.');
  const cookie = getCookie(c, 'captain_shopify_state'); deleteCookie(c, 'captain_shopify_state', { path: '/connections/shopify' });
  c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'no-referrer');
  return c.redirect(await deps.shopifyConnections.finish(new URL(c.req.url).searchParams, cookie, c.get('requestId')));
 });
	app.get('/connections/xero/callback', async (c) => {
		if (!deps.xeroConnections) throw new HttpError(503, 'xero_unavailable', 'Xero connections are not configured.');
		return c.redirect(await deps.xeroConnections.finish(c.req.query('code') ?? '', c.req.query('state') ?? '', c.req.query('error'), c.get('requestId')));
	});
	app.route('/', connectionRoutes(deps));
	app.route('/', gmailPushRoutes(deps.gmailPush));

	const signedIn = new Hono<Vars>();
	signedIn.use('*', async (c, next) => {
		const token = bearer(c.req.header('authorization')); if (!token) throw unauthorised();
		c.set('session', await deps.auth.requireSession(token)); await next();
	});
	signedIn.use('*', rateLimit(limiter, limits.user, limits.organisation, limits.trigger));
	const actor = (c: { get(key: 'session'): Session; get(key: 'requestId'): string }) => ({ userId: c.get('session').userId, requestId: c.get('requestId') });

	signedIn.post('/auth/sign-out', async (c) => { await deps.auth.signOut(bearer(c.req.header('authorization')), c.get('requestId')); return c.json({ ok: true }); });
	signedIn.get('/v1/me', async (c) => c.json({ user: c.get('session').user, memberships: await deps.organisations.memberships(c.get('session').userId), passkeyVerified: c.get('session').passkeyVerifiedAt !== null }));
	// A person's passkeys: registered signed in, presented at every later sign-in.
	signedIn.get('/v1/me/passkeys', async (c) => { if (!deps.passkeys) return c.json({ available: false, passkeys: [] }); return c.json({ available: true, passkeys: await deps.passkeys.list(c.get('session').userId) }); });
	signedIn.post('/v1/me/passkeys/options', async (c) => { if (!deps.passkeys) throw new HttpError(503, 'passkeys_unavailable', 'passkeys are not available on this Captain'); return c.json(await deps.passkeys.registrationOptions(c.get('session').user)); });
	signedIn.post('/v1/me/passkeys', async (c) => {
		if (!deps.passkeys) throw new HttpError(503, 'passkeys_unavailable', 'passkeys are not available on this Captain');
		const input = z.object({ token: z.string().min(1), name: z.string().max(60).default('Passkey'), response: z.unknown() }).parse(await c.req.json());
		return c.json(await deps.passkeys.register(c.get('session').userId, input, c.get('requestId')), 201);
	});
	signedIn.delete('/v1/me/passkeys/:passkeyId', async (c) => {
		if (!deps.passkeys) throw new HttpError(503, 'passkeys_unavailable', 'passkeys are not available on this Captain');
		await deps.passkeys.remove(c.get('session').userId, uuid.parse(c.req.param('passkeyId')), c.get('requestId')); return c.json({ ok: true });
	});

	signedIn.post('/v1/organisations', async (c) => {
		const input = z.object({ name: z.string().trim().min(1).max(120), timezone: z.string().min(1).max(64).optional() }).parse(await c.req.json());
		return c.json(await deps.organisations.create(actor(c), input), 201);
	});
	signedIn.get('/v1/organisations/:id', async (c) => c.json(await deps.organisations.get(actor(c), uuid.parse(c.req.param('id')))));
	signedIn.patch('/v1/organisations/:id', async (c) => {
		const input = z.object({ name: z.string().trim().min(1).max(120).optional(), timezone: z.string().min(1).max(64).optional() }).parse(await c.req.json());
		return c.json(await deps.organisations.update(actor(c), uuid.parse(c.req.param('id')), input));
	});
	signedIn.get('/v1/organisations/:id/export', async (c) => {
		if (!deps.lifecycle) throw new HttpError(503, 'export_unavailable', 'export is not available on this Captain');
		const lines = deps.lifecycle.export(actor(c), uuid.parse(c.req.param('id')));
		// The first line is awaited before the response starts, so a refusal is a status, not a broken stream.
		const first = await lines.next();
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			async start(controller) { if (!first.done) controller.enqueue(encoder.encode(first.value)); },
			async pull(controller) { const next = await lines.next(); if (next.done) controller.close(); else controller.enqueue(encoder.encode(next.value)); }
		});
		return new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-request-id': c.get('requestId') } });
	});
	signedIn.delete('/v1/organisations/:id', async (c) => {
		if (!deps.lifecycle) throw new HttpError(503, 'delete_unavailable', 'deletion is not available on this Captain');
		const input = z.object({ name: z.string().min(1).max(120) }).parse(await c.req.json());
		return c.json(await deps.lifecycle.delete({ ...actor(c), email: c.get('session').user.email }, uuid.parse(c.req.param('id')), input.name));
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
	signedIn.route('/', xeroRoutes(deps));
	signedIn.route('/', shopifyRoutes(deps));
	signedIn.route('/', stockRoutes(deps.stock ?? new StockService(deps.db)));
	signedIn.route('/', contactsRoutes(new ContactsService(deps.db)));
	if (deps.outbox) signedIn.route('/', outboxRoutes(deps.outbox));
	if (deps.triage) signedIn.route('/', threadRoutes(deps.triage));
	if (deps.discovery) signedIn.route('/', discoveryRoutes(deps.discovery));
	if (deps.notes) signedIn.route('/', notesRoutes(deps.notes));
	signedIn.route('/', inferenceRoutes(deps.inference));
	signedIn.route('/', commitmentsRoutes(deps.commitments));
	signedIn.route('/', tagsRoutes(new TagsService(deps.db)));
	signedIn.get('/v1/organisations/:id/mail/watch', async (c) => {
		if (!deps.gmailWatch) { await deps.organisations.get(actor(c), uuid.parse(c.req.param('id'))); return c.json({ configured: false, polling: Boolean(deps.mailScheduleEnabled), status: 'off', expiresAt: null, error: null }); }
		return c.json(await deps.gmailWatch.status(actor(c), uuid.parse(c.req.param('id')), Boolean(deps.mailScheduleEnabled)));
	});
	signedIn.post('/v1/organisations/:id/mail/watch', async (c) => {
		if (!deps.gmailWatch) throw new HttpError(503, 'push_unavailable', 'Live mail updates are not configured.');
		return c.json(await deps.gmailWatch.renew(uuid.parse(c.req.param('id')), actor(c)));
	});
	if (deps.workflows) signedIn.route('/', workflowRoutes(deps.workflows));
	if (deps.push) signedIn.route('/', pushRoutes(deps.push));
	signedIn.get('/v1/organisations/:id/briefs/latest', async c => c.json(await new BriefService(deps.db).latest({ userId: c.get('session').userId, requestId: c.get('requestId') }, z.uuid().parse(c.req.param('id')), deps.workflows ? deps.workflows.runnerProblem('morning-brief') : 'The workflow runner is stopped. Ask the operator to start it.')));
	signedIn.route('/', mailRoutes(new MailService(deps.db, deps.mailSync, deps.mailScheduleEnabled, () => deps.workflows?.runnerProblem('inbox-triage') ?? null)));
	signedIn.route('/', answerRoutes(new AnswerService(deps.db, deps.inference, limiter)));
	signedIn.route('/', calendarRoutes(new CalendarService(deps.db, deps.calendarSync, deps.calendarScheduleEnabled, () => deps.workflows ? deps.workflows.runnerProblem('calendar-prep') : 'The workflow runner is stopped. Ask the operator to start it.')));
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
