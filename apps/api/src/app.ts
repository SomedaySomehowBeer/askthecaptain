import { runtimeRoleIsSafe } from './runtime-role.ts';
import { legacyRetired, retiredRoutes } from './retirement/routes.ts';
import { TagsService } from './tags/service.ts';
import { tagsRoutes } from './tags/routes.ts';
import { equipmentRoutes } from './equipment/routes.ts';
import { savedViewsRoutes } from './views/routes.ts';
import { SavedViewsService } from './views/service.ts';
import { chatRoutes } from './chat/routes.ts';
import { ChatService } from './chat/service.ts';
import { EquipmentService } from './equipment/service.ts';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { shopifyRoutes } from './shopify/routes.ts';
import type { ShopifyConnections } from './shopify/connections.ts';
import type { ShopifySync } from './shopify/sync.ts';
import { StockService } from './stock/service.ts';
import { stockRoutes } from './stock/routes.ts';
import { xeroRoutes } from './xero/routes.ts';
import type { XeroConnections } from './xero/connections.ts';
import type { XeroSync } from './xero/sync.ts';
import { contactsRoutes } from './contacts/routes.ts';
import { ContactsService } from './contacts/service.ts';
import { inferenceRoutes } from './inference/routes.ts';
import type { InferenceService } from './inference/service.ts';
import { connectionRoutes } from './connections/routes.ts';
import { randomUUID } from 'node:crypto';
import type { Sql } from '@captain/db';
import { Hono, type Context } from 'hono';
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
import { callbackErrorCode, callbackFailure, callbackOutcome, clearSessionCookies, clearStepUpCookie, clientHeader, clientHeaderValue, csrfHeaderMissing, sessionCookie, setSessionCookie, setStepUpCookie, stepUpCookie, welcomeError, type CookieSettings } from './web/session.ts';
import { defaultExportDir, webExport } from './web/static.ts';

/** `web`: the Expo web export the API serves from its own origin and the cookie session that goes with it
 *  (docs/plans/expo-web-session-2026-09.md §A). `exportDir` defaults to `apps/mobile/dist/web`; `secureCookies`
 *  is true when the app's URL is https. */
export type Deps = { stock?: StockService; shopifyConnections?: ShopifyConnections; shopifySync?: ShopifySync; shopifyScheduleEnabled?: boolean; inference?: InferenceService; db: Sql; xeroConnections?: XeroConnections; xeroSync?: XeroSync; xeroScheduleEnabled?: boolean; auth: AuthService; organisations: OrganisationService; commitments: CommitmentsService; workflows?: WorkflowService ; push?: PushService ; rateLimiter?: RateLimiter ; lifecycle?: OrganisationLifecycle ; passkeys?: PasskeyService; web?: { exportDir?: string; secureCookies?: boolean } };
/** `sessionVia` says how the session arrived: a bearer request is answered exactly as before; a cookie request
 *  also has its cookies cleared on sign-out. */
type Vars = { Variables: { requestId: string; session: Session; sessionToken: string; sessionVia: 'bearer' | 'cookie' } };

const bearer = (header: string | undefined) => /^Bearer (sess_[A-Za-z0-9_-]+)$/.exec(header ?? '')?.[1];
const uuid = z.string().uuid();
const role = z.enum(['owner', 'admin', 'member']);

/** The HTTP surface. Routes parse and check, services decide and write. Sessions arrive as a bearer token
 *  (the mobile app) or as the `captain_session` cookie the API itself set for the web export it serves. */
export function createApp(deps: Deps) {
	const app = new Hono<Vars>();
	const cookies: CookieSettings = { secure: deps.web?.secureCookies === true };

	app.use('*', async (c, next) => {
		c.set('requestId', c.req.header('x-request-id') ?? randomUUID());
		await next();
		c.header('x-request-id', c.get('requestId'));
		// Every API answer is no-store; only the web export's hashed assets say otherwise, and they say it first.
		if (!c.res.headers.has('cache-control')) c.header('cache-control', 'no-store');
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
		try {
			if (!await runtimeRoleIsSafe(deps.db)) return c.json({ ok: false, reason: 'database role is unsafe' }, 503);
			return c.json({ ok: true });
		} catch { return c.json({ ok: false, reason: 'database unreachable' }, 503); }
	});

	// Sign-in. The web sends people here; Google returns here; the web gets a one-time code.
	// A mobile app starts the same flow with native parameters (mobile foundation contract §3); refused unless enabled.
	app.get('/auth/google/start', async (c) => c.redirect(await deps.auth.startGoogle(c.get('requestId'), c.req.queries())));
	app.get('/auth/google/callback', async (c) => c.redirect((await deps.auth.finishGoogle(c.req.query('code') ?? '', c.req.query('state') ?? '', c.get('requestId'))).toString()));
	// The web sign-in's end (docs/plans/expo-web-session-2026-09.md §A.2): the one-time code is spent here, as the
	// Next.js callback route did, and the session goes into the HttpOnly cookie; the page never holds the token. A
	// person with a passkey gets the step-up cookie and the passkey page instead. A mobile app's sign-in gets its
	// handoff passed to the app's fixed callback, and that path sets, replaces and clears no cookie.
	app.get('/auth/callback', async (c) => {
		const code = c.req.query('code');
		if (!code) return c.redirect(welcomeError(callbackErrorCode(c.req.query('error'))), 303);
		let outcome: ReturnType<typeof callbackOutcome>;
		try { outcome = callbackOutcome(await deps.auth.exchange(code, c.get('requestId'))); }
		catch (caught) { return c.redirect(welcomeError(callbackFailure(caught)), 303); }
		c.header('referrer-policy', 'no-referrer');
		if (outcome.kind === 'stepUp') setStepUpCookie(c, outcome.token, cookies);
		if (outcome.kind === 'session') setSessionCookie(c, outcome.token, outcome.expiresAt, cookies);
		return c.redirect(outcome.location, 303);
	});
	app.post('/auth/session/exchange', async (c) => {
		const input = z.object({ code: z.string().min(1) }).parse(await c.req.json());
		const result = await deps.auth.exchange(input.code, c.get('requestId'));
		// A native sign-in ends in a handoff for the app, never a session; the web only passes the code on.
		if ('nativeHandoff' in result) return c.json({ nativeHandoff: result.nativeHandoff, attempt: result.attempt });
		if ('stepUp' in result) return c.json(result.native ? { stepUp: true, native: true, token: result.token, returnTo: result.returnTo } : { stepUp: true, token: result.token, returnTo: result.returnTo });
		return c.json({ token: result.token, expiresAt: result.session.expiresAt, user: result.session.user, returnTo: result.returnTo });
	});
	// The app spends its handoff with the PKCE verifier and attempt it kept; the session token comes back only here.
	app.post('/auth/native/exchange', async (c) => {
		const result = await deps.auth.nativeExchange(await c.req.json().catch(() => null), c.get('requestId'));
		return c.json({ token: result.token, expiresAt: result.session.expiresAt, user: result.session.user, returnTo: result.returnTo });
	});
	// Passkey step-up between the Google sign-in and the session (plan §9).
	// The token comes in the body as before, or from the step-up cookie the callback set when the body has none.
	const stepUpToken = (c: Context<Vars>, body: { token?: string }): { token: string; fromCookie: boolean } => {
		if (body.token) return { token: body.token, fromCookie: false };
		const token = getCookie(c, stepUpCookie);
		if (!token) throw new HttpError(400, 'invalid_request', 'the request was not understood');
		return { token, fromCookie: true };
	};
	app.post('/auth/passkey/options', async (c) => {
		if (!deps.passkeys) throw unauthorised('passkeys are not available');
		const input = z.object({ token: z.string().min(1).optional() }).parse(await c.req.json());
		return c.json({ options: await deps.auth.stepUpOptions(stepUpToken(c, input).token) });
	});
	app.post('/auth/passkey/verify', async (c) => {
		const input = z.object({ token: z.string().min(1).optional(), response: z.unknown() }).parse(await c.req.json());
		const { token, fromCookie } = stepUpToken(c, input);
		const result = await deps.auth.completeStepUp(token, input.response, c.get('requestId'));
		if (fromCookie) clearStepUpCookie(c, cookies);
		if ('nativeHandoff' in result) return c.json({ nativeHandoff: result.nativeHandoff, attempt: result.attempt });
		// A web step-up through the cookie gets its session in the cookie and never in the page.
		if (fromCookie) { setSessionCookie(c, result.token, result.session.expiresAt, cookies); return c.json({ ok: true, expiresAt: result.session.expiresAt, user: result.session.user, returnTo: result.returnTo }); }
		return c.json({ token: result.token, expiresAt: result.session.expiresAt, user: result.session.user, returnTo: result.returnTo });
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
	app.all('/webhooks/gmail', () => { throw legacyRetired(); });

	// The web export, for every GET that is not the API's (§A.1). Mounted before the signed-in routes so a page
	// never needs a session to load, and after the public API so it never shadows a path the API owns.
	app.use('*', webExport(deps.web?.exportDir ?? defaultExportDir));

	const signedIn = new Hono<Vars>();
	// A bearer token, exactly as before; else the session cookie, accepted only with the web client's header (§A.3).
	signedIn.use('*', async (c, next) => {
		const token = bearer(c.req.header('authorization'));
		if (token) { c.set('sessionVia', 'bearer'); c.set('sessionToken', token); }
		else {
			const fromCookie = getCookie(c, sessionCookie); if (!fromCookie) throw unauthorised();
			if (c.req.header(clientHeader) !== clientHeaderValue) throw csrfHeaderMissing();
			c.set('sessionVia', 'cookie'); c.set('sessionToken', fromCookie);
		}
		c.set('session', await deps.auth.requireSession(c.get('sessionToken'))); await next();
	});
	signedIn.use('*', rateLimit(limiter, limits.user, limits.organisation, limits.trigger, limits.chatWrites, limits.sessionRevocations));
	const actor = (c: { get(key: 'session'): Session; get(key: 'requestId'): string }) => ({ userId: c.get('session').userId, requestId: c.get('requestId') });

	signedIn.post('/auth/sign-out', async (c) => {
		await deps.auth.signOut(c.get('sessionToken'), c.get('requestId'));
		if (c.get('sessionVia') === 'cookie') clearSessionCookies(c, cookies);
		return c.json({ ok: true });
	});
	// Sign out everywhere else (docs/plans/mobile-session-revocation-2026-09.md): ends the person's other sessions. No input.
	signedIn.post('/v1/me/sessions/revoke-others', async (c) => c.json(await deps.auth.revokeOtherSessions(c.get('session'), c.get('requestId'))));
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
	signedIn.route('/', retiredRoutes(deps.db));
	signedIn.route('/', xeroRoutes(deps));
	signedIn.route('/', shopifyRoutes(deps));
	signedIn.route('/', stockRoutes(deps.stock ?? new StockService(deps.db)));
	signedIn.route('/', contactsRoutes(new ContactsService(deps.db)));
	signedIn.route('/', inferenceRoutes(deps.inference));
	signedIn.route('/', commitmentsRoutes(deps.commitments, deps.db));
	signedIn.route('/', tagsRoutes(new TagsService(deps.db)));
	signedIn.route('/', equipmentRoutes(new EquipmentService(deps.db)));
	signedIn.route('/', savedViewsRoutes(new SavedViewsService(deps.db)));
	signedIn.route('/', chatRoutes(new ChatService(deps.db)));
	if (deps.workflows) signedIn.route('/', workflowRoutes(deps.workflows));
	if (deps.push) signedIn.route('/', pushRoutes(deps.push));
	app.route('/', signedIn);

	app.notFound((c) => c.json({ ok: false, code: 'not_found', error: 'not found' }, 404));
	app.onError((error, c) => {
		if (error instanceof HttpError) return c.json({ ok: false, code: error.code, error: error.message, ...(error.field ? { field: error.field } : {}) }, error.status as 400);
		if (error instanceof z.ZodError) return c.json({ ok: false, code: 'invalid_request', error: 'the request was not understood' }, 400);
		console.error(`[${c.get('requestId')}]`, error);
		return c.json({ ok: false, code: 'internal', error: 'something went wrong on our side' }, 500);
	});
	return app;
}
