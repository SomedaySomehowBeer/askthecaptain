import { randomBytes } from 'node:crypto';
import type { Sql, TransactionSql } from '@captain/db';
import { z } from 'zod';
import { badRequest, HttpError, notFound, unauthorised } from '../errors.ts';
import { insertHandoff, lockPasskeys, nativeContext, nativeDisabled, type NativeContext } from './native.ts';
import { hashSecret } from './service.ts';

/** The WebAuthn ceremony behind an interface, so the service is tested without an authenticator.
 *  The production adapter wraps @simplewebauthn/server (plan §9). Options and responses are opaque
 *  JSON to this file; the adapter owns their shape. */
export interface WebAuthn {
	registrationOptions(input: { userId: string; userName: string; displayName: string; excludeCredentialIds: string[] }): Promise<{ challenge: string; options: unknown }>;
	verifyRegistration(input: { response: unknown; challenge: string }): Promise<{ credentialId: string; publicKey: Uint8Array; counter: number; transports: string[]; deviceType: string; backedUp: boolean }>;
	authenticationOptions(input: { allowCredentialIds: string[] }): Promise<{ challenge: string; options: unknown }>;
	verifyAuthentication(input: { response: unknown; challenge: string; credential: { id: string; publicKey: Uint8Array; counter: number; transports: string[] } }): Promise<{ newCounter: number }>;
}

export type Passkey = { id: string; name: string; deviceType: string; backedUp: boolean; createdAt: Date; lastUsedAt: Date | null };
type Stored = { id: string; credentialId: string; publicKey: Uint8Array; counter: number; transports: string[] };
const minutes = (n: number) => n * 60_000;
const secret = (prefix: string) => `${prefix}${randomBytes(32).toString('base64url')}`;
const credentialResponse = z.object({ id: z.string().min(1) }).passthrough();
type Db = Sql | TransactionSql;
/** A step-up request. `native` is kept when the sign-in came from a mobile app, so the step-up ends in a
 *  native handoff and never in a web session. The schema is not strict, so an undeclared key would be
 *  dropped silently; `native` is therefore declared explicitly. */
const stepUpPayload = z.object({ purpose: z.literal('step-up'), returnTo: z.string(), challenge: z.string().optional(), native: nativeContext.optional() });
export type StepUpDone = { userId: string; returnTo: string; passkeyId: string };
export type StepUpHandoff = { userId: string; nativeHandoff: string; attempt: string };

/** Passkeys as a second factor. Registration happens signed in; step-up happens between the Google
 *  sign-in and the session, with a one-time token in place of the session-exchange code. A person
 *  with at least one passkey must present one at every sign-in; nothing is issued otherwise. */
export class PasskeyService {
	readonly #db: Sql; readonly #webauthn: WebAuthn;
	constructor(db: Sql, webauthn: WebAuthn) { this.#db = db; this.#webauthn = webauthn; }

	async list(userId: string): Promise<Passkey[]> {
		return this.#db<Passkey[]>`select id, name, device_type, backed_up, created_at, last_used_at from passkeys where user_id = ${userId} order by created_at`;
	}

	/** Whether sign-in must be stepped up for this person: yes as soon as one passkey exists. */
	async required(userId: string, sql: Db = this.#db): Promise<boolean> {
		const [row] = await sql`select 1 from passkeys where user_id = ${userId} limit 1`;
		return Boolean(row);
	}

	async registrationOptions(user: { id: string; email: string; name: string }): Promise<{ token: string; options: unknown }> {
		const existing = await this.#db<{ credentialId: string }[]>`select credential_id from passkeys where user_id = ${user.id}`;
		const { challenge, options } = await this.#webauthn.registrationOptions({ userId: user.id, userName: user.email, displayName: user.name || user.email, excludeCredentialIds: existing.map((e) => e.credentialId) });
		const token = secret('pkr_');
		await this.#db`insert into auth_requests (kind, token_hash, user_id, payload, expires_at) values ('passkey_challenge', ${hashSecret(token)}, ${user.id}, ${this.#db.json({ purpose: 'register', challenge })}, ${new Date(Date.now() + minutes(10))})`;
		return { token, options };
	}

	async register(userId: string, input: { token: string; name: string; response: unknown }, requestId: string): Promise<Passkey> {
		const request = await this.#consume(input.token, userId);
		const payload = z.object({ purpose: z.literal('register'), challenge: z.string() }).safeParse(request?.payload);
		if (!request || !payload.success) throw badRequest('challenge_invalid', 'that registration has expired; start again');
		credentialResponse.parse(input.response);
		const verified = await this.#webauthn.verifyRegistration({ response: input.response, challenge: payload.data.challenge }).catch(() => null);
		if (!verified) { await this.#event('auth.passkey.register', false, requestId, userId); throw badRequest('passkey_invalid', 'the passkey could not be verified'); }
		const name = input.name.trim().slice(0, 60) || 'Passkey';
		// Under the same per-person lock as the native exchange's passkey check: a registration either commits
		// before that check sees it, or waits until the exchange has finished.
		return this.#db.begin(async (tx) => {
			await lockPasskeys(tx, userId);
			const [row] = await tx<Passkey[]>`insert into passkeys (user_id, credential_id, public_key, counter, transports, device_type, backed_up, name)
				values (${userId}, ${verified.credentialId}, ${Buffer.from(verified.publicKey)}, ${verified.counter}, ${tx.array(verified.transports)}, ${verified.deviceType}, ${verified.backedUp}, ${name})
				on conflict (credential_id) do update set user_id = excluded.user_id, public_key = excluded.public_key, counter = excluded.counter, name = excluded.name
				returning id, name, device_type, backed_up, created_at, last_used_at`;
			await this.#event('auth.passkey.register', true, requestId, userId, { passkeyId: row!.id }, tx);
			return row!;
		}) as Promise<Passkey>;
	}

	async remove(userId: string, passkeyId: string, requestId: string): Promise<void> {
		const rows = await this.#db`delete from passkeys where id = ${passkeyId} and user_id = ${userId} returning id`;
		if (!rows.length) throw notFound('that passkey does not exist');
		await this.#event('auth.passkey.removed', true, requestId, userId, { passkeyId });
	}

	/** Called by the session exchange when a passkey is required: a one-time step-up token that the
	 *  web sends back with the assertion. It carries the destination the sign-in was headed for. */
	async beginStepUp(userId: string, returnTo: string, options: { native?: NativeContext; sql?: Db } = {}): Promise<string> {
		const token = secret('pks_'); const sql = options.sql ?? this.#db;
		const payload = options.native ? { purpose: 'step-up', returnTo, native: options.native } : { purpose: 'step-up', returnTo };
		await sql`insert into auth_requests (kind, token_hash, user_id, payload, expires_at) values ('passkey_challenge', ${hashSecret(token)}, ${userId}, ${sql.json(payload)}, ${new Date(Date.now() + minutes(10))})`;
		return token;
	}

	/** Assertion options for a step-up token; the challenge is stored on the same request. */
	async stepUpOptions(token: string, flags: { nativeEnabled?: boolean } = {}): Promise<unknown> {
		const request = await this.#peek(token, 'step-up');
		// A mobile step-up is a native leg too: while mobile sign-in is off it gets no assertion options. The
		// token is left unspent here, and verifying it later refuses and burns it the same way.
		const payload = stepUpPayload.safeParse(request.payload);
		if (!payload.success) throw unauthorised('that sign-in has expired; start again');
		if (payload.data.native && !flags.nativeEnabled) throw nativeDisabled();
		const credentials = await this.#db<{ credentialId: string }[]>`select credential_id from passkeys where user_id = ${request.userId}`;
		if (credentials.length === 0) throw unauthorised('no passkey is registered for this account');
		const { challenge, options } = await this.#webauthn.authenticationOptions({ allowCredentialIds: credentials.map((c) => c.credentialId) });
		await this.#db`update auth_requests set payload = payload || ${this.#db.json({ challenge })} where token_hash = ${hashSecret(token)} and kind = 'passkey_challenge'`;
		return options;
	}

	/** Verifies the assertion, spends the token, and returns who signed in and where they were going.
	 *  Everything runs in one transaction: spending the token, the counter update, the events and, for a
	 *  sign-in from a mobile app, the native handoff. A refusal still commits the spent token and its failure
	 *  event, so a failed attempt cannot be retried with the same token. A step-up from a mobile app never
	 *  returns a web sign-in: it returns a handoff, and only while `nativeEnabled` is true. */
	async completeStepUp(token: string, response: unknown, requestId: string, options: { nativeEnabled?: boolean } = {}): Promise<StepUpDone | StepUpHandoff> {
		const outcome = await this.#db.begin(async (tx) => {
			const refuse = (error: HttpError) => ({ error });
			const request = await this.#consume(token, undefined, tx);
			const payload = stepUpPayload.safeParse(request?.payload);
			if (!request?.userId || !payload.success || !payload.data.challenge) return refuse(unauthorised('that sign-in has expired; start again'));
			const userId = request.userId; const native = payload.data.native;
			if (native && !options.nativeEnabled) {
				await this.#event('auth.passkey.step_up', false, requestId, userId, { client: 'native', reason: 'native_sign_in_disabled' }, tx);
				return refuse(nativeDisabled());
			}
			const parsed = credentialResponse.safeParse(response);
			if (!parsed.success) return refuse(unauthorised('the passkey response was not understood'));
			const [credential] = await tx<Stored[]>`select id, credential_id, public_key, counter::int as counter, transports from passkeys where user_id = ${userId} and credential_id = ${parsed.data.id}`;
			if (!credential) { await this.#event('auth.passkey.step_up', false, requestId, userId, { reason: 'unknown_credential' }, tx); return refuse(unauthorised('that passkey is not registered for this account')); }
			const verified = await this.#webauthn.verifyAuthentication({ response, challenge: payload.data.challenge, credential: { id: credential.credentialId, publicKey: credential.publicKey, counter: credential.counter, transports: credential.transports } }).catch(() => null);
			if (!verified) { await this.#event('auth.passkey.step_up', false, requestId, userId, {}, tx); return refuse(unauthorised('the passkey could not be verified')); }
			await tx`update passkeys set counter = ${verified.newCounter}, last_used_at = now() where id = ${credential.id}`;
			await this.#event('auth.passkey.step_up', true, requestId, userId, { passkeyId: credential.id }, tx);
			if (!native) return { done: { userId, returnTo: payload.data.returnTo, passkeyId: credential.id } as StepUpDone | StepUpHandoff };
			const nativeHandoff = await insertHandoff(tx, userId, { ...native, returnTo: payload.data.returnTo, passkeyVerified: true });
			await this.#event('auth.native.handoff', true, requestId, userId, { client: 'native', passkey: true }, tx);
			return { done: { userId, nativeHandoff, attempt: native.attempt } as StepUpDone | StepUpHandoff };
		}) as { error: HttpError } | { done: StepUpDone | StepUpHandoff };
		if ('error' in outcome) throw outcome.error;
		return outcome.done;
	}

	async #peek(token: string, purpose: string): Promise<{ userId: string; payload: unknown }> {
		const [row] = await this.#db<{ userId: string | null; payload: unknown }[]>`select user_id, payload from auth_requests where kind = 'passkey_challenge' and token_hash = ${hashSecret(token)} and consumed_at is null and expires_at > now()`;
		const parsed = z.object({ purpose: z.literal(purpose) }).safeParse(row?.payload);
		if (!row?.userId || !parsed.success) throw unauthorised('that sign-in has expired; start again');
		return { userId: row.userId, payload: row.payload };
	}

	async #consume(token: string, userId?: string, sql: Db = this.#db): Promise<{ userId: string | null; payload: unknown } | null> {
		const [row] = await sql<{ userId: string | null; payload: unknown }[]>`update auth_requests set consumed_at = now()
			where kind = 'passkey_challenge' and token_hash = ${hashSecret(token)} and consumed_at is null and expires_at > now() and (${userId ?? null}::uuid is null or user_id = ${userId ?? null}::uuid) returning user_id, payload`;
		return row ?? null;
	}

	async #event(event: string, success: boolean, requestId: string, userId?: string, detail: Record<string, unknown> = {}, sql: Db = this.#db) {
		await sql`insert into auth_events (event, success, request_id, user_id, detail) values (${event}, ${success}, ${requestId}, ${userId ?? null}, ${sql.json(detail as never)})`;
	}
}
