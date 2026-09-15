import { createHash, randomBytes } from 'node:crypto';
import type { Sql } from '@captain/db';
import { z } from 'zod';
import { badRequest, unauthorised } from '../errors.ts';
import type { IdentityProvider } from './google.ts';
import type { PasskeyService } from './passkeys.ts';

export const hashSecret = (secret: string) => createHash('sha256').update(secret).digest('hex');
const secret = (prefix: string) => `${prefix}${randomBytes(32).toString('base64url')}`;

export type SessionUser = { id: string; email: string; name: string };
export type Session = { id: string; userId: string; expiresAt: Date; user: SessionUser; passkeyVerifiedAt: Date | null };
export type Exchanged = { token: string; session: Session; returnTo: string } | { stepUp: true; token: string; returnTo: string };

const minutes = (n: number) => n * 60_000;

/** Sign-in and sessions. Sessions are opaque tokens whose hash is stored; the token itself lives
 *  only in the web app's cookie and in the Authorization header on its way here. The Google flow
 *  starts and finishes on this API and hands the web a one-time exchange code, so the session token
 *  never travels in a redirect URL. */
export class AuthService {
	readonly #db: Sql; readonly #google: IdentityProvider | null; readonly #appUrl: URL; readonly #sessionTtlMs: number; readonly #passkeys: PasskeyService | null;
	constructor(db: Sql, google: IdentityProvider | null, options: { appUrl: string; sessionTtlDays: number; passkeys?: PasskeyService }) {
		this.#db = db; this.#google = google; this.#appUrl = new URL(options.appUrl); this.#sessionTtlMs = options.sessionTtlDays * 24 * 60 * 60_000; this.#passkeys = options.passkeys ?? null;
	}

	get googleAvailable() { return this.#google !== null; }

	async startGoogle(requestId: string, returnTo?: string): Promise<string> {
		if (!this.#google) throw badRequest('google_unavailable', 'Google sign-in is not configured');
		const path = this.#returnPath(returnTo);
		const state = secret('st_'); const nonce = secret('n_'); const verifier = secret('v_');
		const challenge = createHash('sha256').update(verifier).digest('base64url');
		await this.#db`insert into auth_requests (kind, token_hash, payload, expires_at)
			values ('oauth', ${hashSecret(state)}, ${this.#db.json({ nonce, verifier, returnTo: path })}, ${new Date(Date.now() + minutes(15))})`;
		await this.#event('auth.google.start', true, requestId);
		return this.#google.authorizationUrl({ state, nonce, codeChallenge: challenge });
	}

	/** Returns where the web should be sent: with a code to exchange, or an error to say. */
	async finishGoogle(code: string, state: string, requestId: string): Promise<URL> {
		const target = new URL('/auth/callback', this.#appUrl);
		const request = await this.#consume('oauth', state);
		if (!request || !this.#google) { await this.#event('auth.google.finish', false, requestId, undefined, { reason: 'request_invalid' });
			target.searchParams.set('error', 'request_invalid'); return target; }
		const payload = z.object({ nonce: z.string(), verifier: z.string(), returnTo: z.string() }).parse(request.payload);
		try {
			const identity = await this.#google.exchange({ code, codeVerifier: payload.verifier, nonce: payload.nonce });
			const user = await this.#findOrCreateUser('google', identity);
			const exchange = secret('x_');
			await this.#db`insert into auth_requests (kind, token_hash, user_id, payload, expires_at)
				values ('session_exchange', ${hashSecret(exchange)}, ${user.id}, ${this.#db.json({ returnTo: payload.returnTo })}, ${new Date(Date.now() + minutes(2))})`;
			await this.#event('auth.google.finish', true, requestId, user.id);
			target.searchParams.set('code', exchange);
		} catch (error) {
			await this.#event('auth.google.finish', false, requestId, undefined, { reason: error instanceof Error ? error.message : 'unknown' });
			target.searchParams.set('error', 'google_failed');
		}
		return target;
	}

	/** Spends the one-time code. A person with a passkey gets a step-up token instead of a session;
	 *  the session is issued only after `completeStepUp` (plan §9). */
	async exchange(code: string, requestId: string): Promise<Exchanged> {
		const request = await this.#consume('session_exchange', code);
		if (!request?.userId) { await this.#event('auth.session.exchange', false, requestId); throw unauthorised('sign-in link is invalid or expired'); }
		const returnTo = z.object({ returnTo: z.string() }).parse(request.payload).returnTo;
		if (this.#passkeys && (await this.#passkeys.required(request.userId))) {
			const token = await this.#passkeys.beginStepUp(request.userId, returnTo);
			await this.#event('auth.session.step_up_required', true, requestId, request.userId);
			return { stepUp: true, token, returnTo };
		}
		const issued = await this.#issueSession(request.userId);
		await this.#event('auth.session.exchange', true, requestId, request.userId);
		return { ...issued, returnTo };
	}

	/** Finishes a stepped-up sign-in: the assertion is verified by the passkey service, then the
	 *  session is issued and marked as passkey-verified. */
	async completeStepUp(token: string, response: unknown, requestId: string): Promise<{ token: string; session: Session; returnTo: string }> {
		if (!this.#passkeys) throw unauthorised('passkeys are not available');
		const done = await this.#passkeys.completeStepUp(token, response, requestId);
		const issued = await this.#issueSession(done.userId, true);
		await this.#event('auth.session.exchange', true, requestId, done.userId, { passkey: true });
		return { ...issued, returnTo: done.returnTo };
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

	/** Test and development seam: a session for a known user without Google. */
	async issueSessionFor(userId: string) { return this.#issueSession(userId); }

	async #issueSession(userId: string, passkeyVerified = false): Promise<{ token: string; session: Session }> {
		const token = secret('sess_'); const expiresAt = new Date(Date.now() + this.#sessionTtlMs); const verifiedAt = passkeyVerified ? new Date() : null;
		const [row] = await this.#db<{ id: string; email: string; name: string }[]>`
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

	async #consume(kind: 'oauth' | 'session_exchange', token: string): Promise<{ userId: string | null; payload: unknown } | null> {
		const [row] = await this.#db<{ userId: string | null; payload: unknown }[]>`update auth_requests set consumed_at = now()
			where kind = ${kind} and token_hash = ${hashSecret(token)} and consumed_at is null and expires_at > now() returning user_id, payload`;
		return row ?? null;
	}

	#returnPath(value: string | undefined): string {
		if (!value) return '/';
		if (!value.startsWith('/') || value.startsWith('//')) throw badRequest('return_to_invalid', 'return_to must be a path on this app');
		return value;
	}

	async #event(event: string, success: boolean, requestId: string, userId?: string, detail: Record<string, unknown> = {}) {
		await this.#db`insert into auth_events (event, success, request_id, user_id, detail) values (${event}, ${success}, ${requestId}, ${userId ?? null}, ${this.#db.json(detail as never)})`;
	}
}
