import { createHash, randomBytes } from 'node:crypto';
import type { Sql, TransactionSql } from '@captain/db';
import { z } from 'zod';
import { badRequest, type HttpError, unauthorised } from '../errors.ts';
import type { IdentityProvider } from './google.ts';
import { handoffPayload, insertHandoff, lockPasskeys, nativeContext, nativeDisabled, nativeExchangeInput, parseStart, s256, sameSecret } from './native.ts';
import type { PasskeyService } from './passkeys.ts';
import { safeReturnPath } from './return-path.ts';

export const hashSecret = (secret: string) => createHash('sha256').update(secret).digest('hex');
const secret = (prefix: string) => `${prefix}${randomBytes(32).toString('base64url')}`;
type Db = Sql | TransactionSql;

/** The per-person lock that orders "sign out everywhere else" calls, before hashing. Exported so a test can hold or
 *  find that exact lock. It is distinct from the passkey lock and taken by no other path. */
export const sessionLockName = (userId: string) => `captain.sessions:${userId}`;

export type SessionUser = { id: string; email: string; name: string };
export type Session = { id: string; userId: string; expiresAt: Date; user: SessionUser; passkeyVerifiedAt: Date | null };
export type Issued = { token: string; session: Session; returnTo: string };
/** What spending a web or native exchange code yields. A native sign-in never yields a session here: it
 *  yields a step-up (marked `native`) or a handoff that only the app can spend (§3 of the mobile contract). */
export type Exchanged = Issued | { stepUp: true; native?: true; token: string; returnTo: string } | NativeHandoff;
export type NativeHandoff = { nativeHandoff: string; attempt: string };

const minutes = (n: number) => n * 60_000;
/** A destination read back from a stored auth request is checked again before it is used: a row written by an
 *  older release, or altered in the database, never sends anyone off this app. It falls back to the home page. */
const storedReturn = (value: string) => safeReturnPath(value) ?? '/';
const oauthPayload = z.object({ nonce: z.string(), verifier: z.string(), returnTo: z.string(), native: nativeContext.optional() });
const exchangePayload = z.object({ returnTo: z.string(), native: nativeContext.optional() });

/** Sign-in and sessions. Sessions are opaque tokens whose hash is stored; the token itself lives
 *  only in the web app's cookie and in the Authorization header on its way here. The Google flow
 *  starts and finishes on this API and hands the web a one-time exchange code, so the session token
 *  never travels in a redirect URL. A mobile app uses the same flow and finishes with a native handoff,
 *  which it spends at `nativeExchange` with its PKCE verifier; that path is off unless `nativeSignIn`. */
export class AuthService {
	readonly #db: Sql; readonly #google: IdentityProvider | null; readonly #appUrl: URL; readonly #sessionTtlMs: number; readonly #passkeys: PasskeyService | null; readonly #native: boolean;
	constructor(db: Sql, google: IdentityProvider | null, options: { appUrl: string; sessionTtlDays: number; passkeys?: PasskeyService; nativeSignIn?: boolean }) {
		this.#db = db; this.#google = google; this.#appUrl = new URL(options.appUrl); this.#sessionTtlMs = options.sessionTtlDays * 24 * 60 * 60_000; this.#passkeys = options.passkeys ?? null;
		this.#native = options.nativeSignIn === true;
	}

	get googleAvailable() { return this.#google !== null; }

	/** `query` is the whole start query. Without native parameters it is the web flow, unchanged. */
	async startGoogle(requestId: string, query: Record<string, string[]> = {}): Promise<string> {
		if (!this.#google) throw badRequest('google_unavailable', 'Google sign-in is not configured');
		const start = parseStart(query, this.#native);
		const path = this.#returnPath(start.returnTo);
		const state = secret('st_'); const nonce = secret('n_'); const verifier = secret('v_');
		const challenge = createHash('sha256').update(verifier).digest('base64url');
		const payload = start.native ? { nonce, verifier, returnTo: path, native: start.native } : { nonce, verifier, returnTo: path };
		await this.#db`insert into auth_requests (kind, token_hash, payload, expires_at)
			values ('oauth', ${hashSecret(state)}, ${this.#db.json(payload)}, ${new Date(Date.now() + minutes(15))})`;
		await this.#event('auth.google.start', true, requestId, undefined, start.native ? { client: 'native' } : {});
		return this.#google.authorizationUrl({ state, nonce, codeChallenge: challenge });
	}

	/** Returns where the web should be sent: with a code to exchange, or an error to say. */
	async finishGoogle(code: string, state: string, requestId: string): Promise<URL> {
		const target = new URL('/auth/callback', this.#appUrl);
		const request = await this.#consume('oauth', state);
		const payload = oauthPayload.safeParse(request?.payload);
		if (!request || !this.#google || !payload.success) { await this.#event('auth.google.finish', false, requestId, undefined, { reason: 'request_invalid' });
			target.searchParams.set('error', 'request_invalid'); return target; }
		const native = payload.data.native;
		if (native && !this.#native) {
			// Started while mobile sign-in was on, finished after it was turned off: stop before Google is asked.
			await this.#event('auth.google.finish', false, requestId, undefined, { client: 'native', reason: 'native_sign_in_disabled' });
			target.searchParams.set('error', 'native_sign_in_disabled'); return target;
		}
		try {
			const identity = await this.#google.exchange({ code, codeVerifier: payload.data.verifier, nonce: payload.data.nonce });
			const user = await this.#findOrCreateUser('google', identity);
			const exchange = secret('x_'); const returnTo = storedReturn(payload.data.returnTo);
			await this.#db`insert into auth_requests (kind, token_hash, user_id, payload, expires_at)
				values ('session_exchange', ${hashSecret(exchange)}, ${user.id}, ${this.#db.json(native ? { returnTo, native } : { returnTo })}, ${new Date(Date.now() + minutes(2))})`;
			await this.#event('auth.google.finish', true, requestId, user.id, native ? { client: 'native' } : {});
			target.searchParams.set('code', exchange);
		} catch (error) {
			await this.#event('auth.google.finish', false, requestId, undefined, { reason: error instanceof Error ? error.message : 'unknown' });
			target.searchParams.set('error', 'google_failed');
		}
		return target;
	}

	/** Spends the one-time code. A person with a passkey gets a step-up token instead of a session;
	 *  the session is issued only after `completeStepUp` (plan §9). For a native sign-in the code is spent,
	 *  and a step-up or a handoff is created, in one transaction. No session is ever issued here for it. */
	async exchange(code: string, requestId: string): Promise<Exchanged> {
		const outcome = await this.#db.begin(async (tx) => {
			const request = await this.#consume('session_exchange', code, tx);
			const payload = exchangePayload.safeParse(request?.payload);
			if (!request?.userId || !payload.success) {
				await this.#event('auth.session.exchange', false, requestId, request?.userId ?? undefined, {}, tx);
				return { error: unauthorised('sign-in link is invalid or expired') as HttpError };
			}
			const userId = request.userId; const returnTo = storedReturn(payload.data.returnTo); const native = payload.data.native;
			if (!native) return { web: { userId, returnTo } };
			if (!this.#native) {
				await this.#event('auth.session.exchange', false, requestId, userId, { client: 'native', reason: 'native_sign_in_disabled' }, tx);
				return { error: nativeDisabled() };
			}
			if (this.#passkeys && (await this.#passkeys.required(userId, tx))) {
				const token = await this.#passkeys.beginStepUp(userId, returnTo, { native, sql: tx });
				await this.#event('auth.session.step_up_required', true, requestId, userId, { client: 'native' }, tx);
				return { result: { stepUp: true, native: true, token, returnTo } as Exchanged };
			}
			const nativeHandoff = await insertHandoff(tx, userId, { ...native, returnTo, passkeyVerified: false });
			await this.#event('auth.native.handoff', true, requestId, userId, { client: 'native', passkey: false }, tx);
			return { result: { nativeHandoff, attempt: native.attempt } as Exchanged };
		}) as { error: HttpError } | { result: Exchanged } | { web: { userId: string; returnTo: string } };
		if ('error' in outcome) throw outcome.error;
		if ('result' in outcome) return outcome.result;
		// The web flow, unchanged: the spent code has been committed, then a step-up or a session follows.
		const { userId, returnTo } = outcome.web;
		if (this.#passkeys && (await this.#passkeys.required(userId))) {
			const token = await this.#passkeys.beginStepUp(userId, returnTo);
			await this.#event('auth.session.step_up_required', true, requestId, userId);
			return { stepUp: true, token, returnTo };
		}
		const issued = await this.#issueSession(userId);
		await this.#event('auth.session.exchange', true, requestId, userId);
		return { ...issued, returnTo };
	}

	/** Assertion options for a step-up token. A native step-up gets them only while mobile sign-in is on. */
	async stepUpOptions(token: string): Promise<unknown> {
		if (!this.#passkeys) throw unauthorised('passkeys are not available');
		return this.#passkeys.stepUpOptions(token, { nativeEnabled: this.#native });
	}

	/** Finishes a stepped-up sign-in: the assertion is verified by the passkey service, then the
	 *  session is issued and marked as passkey-verified. A native step-up returns its handoff instead. */
	async completeStepUp(token: string, response: unknown, requestId: string): Promise<Issued | NativeHandoff> {
		if (!this.#passkeys) throw unauthorised('passkeys are not available');
		const done = await this.#passkeys.completeStepUp(token, response, requestId, { nativeEnabled: this.#native });
		if ('nativeHandoff' in done) return { nativeHandoff: done.nativeHandoff, attempt: done.attempt };
		const issued = await this.#issueSession(done.userId, true);
		await this.#event('auth.session.exchange', true, requestId, done.userId, { passkey: true });
		return { ...issued, returnTo: storedReturn(done.returnTo) };
	}

	/** The app spends its handoff with the verifier and attempt it kept (mobile contract §3.3). Spending the
	 *  code, the checks, the session and its audit event share one transaction; the token is returned only
	 *  after commit. A mismatch still burns the code. A handoff issued without a passkey is refused if the
	 *  person has registered one since (checked under the same lock as registration). */
	async nativeExchange(input: unknown, requestId: string): Promise<Issued> {
		const parsed = nativeExchangeInput.safeParse(input);
		if (!parsed.success) throw badRequest('native_request_invalid', 'That sign-in could not be finished. Start sign-in again.');
		const { code, verifier, attempt } = parsed.data;
		const outcome = await this.#db.begin(async (tx) => {
			const refuse = async (reason: string, userId: string | undefined, error: HttpError = unauthorised('that sign-in has expired; start sign-in again')) => {
				await this.#event('auth.native.exchange', false, requestId, userId, { client: 'native', reason }, tx);
				return { error };
			};
			const [row] = await tx<{ userId: string | null; payload: unknown }[]>`update auth_requests set consumed_at = now()
				where kind = 'native_handoff' and token_hash = ${hashSecret(code)} and consumed_at is null and expires_at > now() returning user_id, payload`;
			if (!row?.userId) return refuse('request_invalid', undefined);
			if (!this.#native) return refuse('native_sign_in_disabled', row.userId, nativeDisabled());
			const payload = handoffPayload.safeParse(row.payload);
			if (!payload.success) return refuse('request_invalid', row.userId);
			// Both comparisons always run, so the time taken does not say which one failed.
			const verifierMatches = sameSecret(s256(verifier), payload.data.challenge); const attemptMatches = sameSecret(attempt, payload.data.attempt);
			if (!verifierMatches || !attemptMatches) return refuse('binding_mismatch', row.userId);
			if (!payload.data.passkeyVerified) {
				await lockPasskeys(tx, row.userId);
				const [passkey] = await tx`select 1 from passkeys where user_id = ${row.userId} limit 1`;
				if (passkey) return refuse('passkey_required', row.userId, unauthorised('this account now needs its passkey; start sign-in again'));
			}
			const issued = await this.#issueSession(row.userId, payload.data.passkeyVerified, tx);
			await this.#event('auth.native.exchange', true, requestId, row.userId, { client: 'native', passkey: payload.data.passkeyVerified }, tx);
			return { issued: { ...issued, returnTo: storedReturn(payload.data.returnTo) } };
		}) as { error: HttpError } | { issued: Issued };
		if ('error' in outcome) throw outcome.error;
		return outcome.issued;
	}

	async requireSession(token: string | undefined): Promise<Session> {
		if (!token || !token.startsWith('sess_')) throw unauthorised();
		const [row] = await this.#db<{ id: string; userId: string; expiresAt: Date; revokedAt: Date | null; passkeyVerifiedAt: Date | null; email: string; name: string }[]>`
			select s.id, s.user_id, s.expires_at, s.revoked_at, s.passkey_verified_at, u.email, u.name from sessions s join users u on u.id = s.user_id where s.token_hash = ${hashSecret(token)}`;
		if (!row || row.revokedAt || row.expiresAt <= new Date()) throw unauthorised();
		return { id: row.id, userId: row.userId, expiresAt: row.expiresAt, passkeyVerifiedAt: row.passkeyVerifiedAt, user: { id: row.userId, email: row.email, name: row.name } };
	}

	async signOut(token: string | undefined, requestId: string): Promise<void> {
		if (!token) return;
		const rows = await this.#db`update sessions set revoked_at = now() where token_hash = ${hashSecret(token)} and revoked_at is null returning user_id`;
		if (rows.length) await this.#event('auth.sign_out', true, requestId, rows[0]!.userId);
	}

	/** Sign out everywhere else (docs/plans/mobile-session-revocation-2026-09.md §2): ends the person's other existing
	 *  sessions and keeps the one making the call. It takes no input: the person and the current session come only from
	 *  the verified bearer. Pending sign-ins are not touched, so this is not an account lockout.
	 *  - A per-person lock orders these calls. After it, the current session is checked again at the statement's own
	 *    time (`statement_timestamp()`, never `now()`, which was taken before the lock wait): one ended while queued,
	 *    by a concurrent call or by expiry, is refused with the same 401 as the middleware's. The refusal's event
	 *    commits: the failure is returned from the transaction and thrown after it.
	 *  - One statement revokes and counts at one instant. `ended` counts only sessions that had not expired; one revoked
	 *    concurrently by another path is skipped by the update's recheck. The current session is excluded by this call;
	 *    nothing here keeps another path from ending it afterwards.
	 *  - The response and the event carry a count, or the refusal's reason, and nothing else. */
	async revokeOtherSessions(session: Session, requestId: string): Promise<{ ended: number }> {
		const outcome = await this.#db.begin(async (tx) => {
			await tx`select pg_advisory_xact_lock(hashtextextended(${sessionLockName(session.userId)}, 0))`;
			const [live] = await tx`select 1 from sessions
				where id = ${session.id} and user_id = ${session.userId} and revoked_at is null and expires_at > statement_timestamp()`;
			if (!live) {
				await this.#event('auth.sessions.revoke_others', false, requestId, session.userId, { reason: 'current_session_ended' }, tx);
				return { error: unauthorised() };
			}
			const [row] = await tx<{ ended: number }[]>`with revoked as (
					update sessions set revoked_at = statement_timestamp()
					where user_id = ${session.userId} and id <> ${session.id} and revoked_at is null
					returning expires_at)
				select count(*) filter (where expires_at > statement_timestamp())::int as ended from revoked`;
			const ended = row!.ended;
			await this.#event('auth.sessions.revoke_others', true, requestId, session.userId, { ended }, tx);
			return { ended };
		}) as { error: HttpError } | { ended: number };
		if ('error' in outcome) throw outcome.error;
		return { ended: outcome.ended };
	}

	/** Test and development seam: a session for a known user without Google. */
	async issueSessionFor(userId: string) { return this.#issueSession(userId); }

	async #issueSession(userId: string, passkeyVerified = false, sql: Db = this.#db): Promise<{ token: string; session: Session }> {
		const token = secret('sess_'); const expiresAt = new Date(Date.now() + this.#sessionTtlMs); const verifiedAt = passkeyVerified ? new Date() : null;
		const [row] = await sql<{ id: string; email: string; name: string }[]>`
			with s as (insert into sessions (user_id, token_hash, expires_at, passkey_verified_at) values (${userId}, ${hashSecret(token)}, ${expiresAt}, ${verifiedAt}) returning id, user_id)
			select s.id, u.email, u.name from s join users u on u.id = s.user_id`;
		return { token, session: { id: row!.id, userId, expiresAt, passkeyVerifiedAt: verifiedAt, user: { id: userId, email: row!.email, name: row!.name } } };
	}

	async #findOrCreateUser(provider: string, identity: { subject: string; email: string; name: string }): Promise<SessionUser> {
		return this.#db.begin(async (tx) => {
			const [known] = await tx<SessionUser[]>`select u.id, u.email, u.name from identities i join users u on u.id = i.user_id
				where i.provider = ${provider} and i.subject = ${identity.subject}`;
			if (known) return known;
			const [user] = await tx<SessionUser[]>`insert into users (email, name) values (${identity.email}, ${identity.name})
				on conflict (email) do update set name = case when users.name = '' then excluded.name else users.name end returning id, email, name`;
			await tx`insert into identities (user_id, provider, subject, email) values (${user!.id}, ${provider}, ${identity.subject}, ${identity.email})`;
			return user!;
		}) as Promise<SessionUser>;
	}

	async #consume(kind: 'oauth' | 'session_exchange', token: string, sql: Db = this.#db): Promise<{ userId: string | null; payload: unknown } | null> {
		const [row] = await sql<{ userId: string | null; payload: unknown }[]>`update auth_requests set consumed_at = now()
			where kind = ${kind} and token_hash = ${hashSecret(token)} and consumed_at is null and expires_at > now() returning user_id, payload`;
		return row ?? null;
	}

	/** The requested destination, checked where it enters: anything but a same-origin path is refused. */
	#returnPath(value: string | undefined): string {
		if (!value) return '/';
		const path = safeReturnPath(value);
		if (path === null) throw badRequest('return_to_invalid', 'return_to must be a path on this app');
		return path;
	}

	async #event(event: string, success: boolean, requestId: string, userId?: string, detail: Record<string, unknown> = {}, sql: Db = this.#db) {
		await sql`insert into auth_events (event, success, request_id, user_id, detail) values (${event}, ${success}, ${requestId}, ${userId ?? null}, ${sql.json(detail as never)})`;
	}
}
