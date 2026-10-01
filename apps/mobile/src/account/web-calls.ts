import { createPushCalls, type PushCalls } from './push.ts';
import { createThreadCalls, type ThreadCalls } from '../threads/api.ts';
import { createMembersCalls, type MemberScope, type MembersCalls } from './members.ts';
/** The web-only requests the account source makes for its screens (docs/plans/expo-web-session-2026-09.md §B.2):
 *  the passkey step-up, passkey management and accepting an invitation. Pure over the injected API client (no session
 *  token: on the web the cookie is the session), so node tests use fakes; src/account/web-session.ts builds it with its own
 *  hooks. Every parser is strict and never repeats a value; a body that does not fit is reported as unavailable. */
import { apiPaths, googleStartPath, isCanonicalInstant, passkeyPath } from '../api/paths.ts';
import type { ApiClient, ApiOutcome } from '../auth/contracts.ts';
import { callbackUrl } from '../auth/callback.ts';
import { safeReturnPath } from '../lib/links.ts';
import { parseMembership, type Membership } from './me.ts';
import { isCanonicalUuid } from './session.ts';

const refuse = (what: string): never => { throw new TypeError(`${what}: the answer was not in the expected form`); };
const isRecord = (value: unknown): value is Record<string, unknown> => {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
};
const hasExactly = (value: Record<string, unknown>, keys: readonly string[]) =>
	Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));

/** `POST /auth/passkey/options`: `{ options }`, the assertion options for the browser. Only their presence is checked
 *  here; `@simplewebauthn/browser` reads them. */
export function parseStepUpOptions(value: unknown): { readonly options: unknown } {
	if (!isRecord(value) || !hasExactly(value, ['options']) || !isRecord(value.options)) return refuse('step-up options');
	return Object.freeze({ options: value.options });
}

/** `POST /auth/passkey/verify` on the web: the API has set the session cookie; the app keeps only where to go next
 *  (`returnTo`, a same-origin path, else `/`). A bearer response is refused. Native mode accepts only the fixed one-time PKCE handoff. */
export function parseStepUpVerified(value: unknown, native = false): { readonly returnTo: string } {
	if (native) {
		if (!isRecord(value) || !hasExactly(value, ['nativeHandoff', 'attempt']) || typeof value.nativeHandoff !== 'string' || !/^nh_[A-Za-z0-9_-]{43}$/.test(value.nativeHandoff) || typeof value.attempt !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.attempt)) return refuse('native step-up');
		return Object.freeze({ returnTo: `${callbackUrl}?code=${value.nativeHandoff}&attempt=${value.attempt}` });
	}
	if (!isRecord(value) || !hasExactly(value, ['ok', 'expiresAt', 'user', 'returnTo']) || value.ok !== true || !isCanonicalInstant(value.expiresAt) || !isRecord(value.user) || !isCanonicalUuid(value.user.id)) return refuse('step-up');
	const returnTo = safeReturnPath(value.returnTo);
	return Object.freeze({ returnTo: returnTo === null || returnTo.startsWith('/auth/') ? '/' : returnTo });
}

export type Passkey = {
	readonly id: string; readonly name: string; readonly backedUp: boolean; readonly createdAt: string; readonly lastUsedAt: string | null;
};
export type PasskeyList = { readonly available: boolean; readonly passkeys: readonly Passkey[] };
const maxPasskeys = 100;

/** `GET /v1/me/passkeys` (apps/api/src/app.ts): `{ available, passkeys }`; each passkey exactly the API's six fields,
 *  of which the device type is not shown and so not kept. */
export function parsePasskeys(value: unknown): PasskeyList {
	if (!isRecord(value) || !hasExactly(value, ['available', 'passkeys']) || typeof value.available !== 'boolean') return refuse('passkeys');
	if (!Array.isArray(value.passkeys) || value.passkeys.length > maxPasskeys) return refuse('passkeys');
	const passkeys = value.passkeys.map((entry): Passkey => {
		if (!isRecord(entry) || !hasExactly(entry, ['id', 'name', 'deviceType', 'backedUp', 'createdAt', 'lastUsedAt'])) return refuse('passkeys');
		const { id, name, deviceType, backedUp, createdAt, lastUsedAt } = entry;
		if (!isCanonicalUuid(id) || typeof name !== 'string' || name.length === 0 || name.length > 60 || typeof deviceType !== 'string') return refuse('passkeys');
		if (typeof backedUp !== 'boolean' || !isCanonicalInstant(createdAt) || !(lastUsedAt === null || isCanonicalInstant(lastUsedAt))) return refuse('passkeys');
		return Object.freeze({ id, name, backedUp, createdAt, lastUsedAt });
	});
	if (new Set(passkeys.map((p) => p.id)).size !== passkeys.length) return refuse('passkeys');
	return Object.freeze({ available: value.available, passkeys: Object.freeze(passkeys) });
}

/** What accepting an invitation answers. It never rejects.
 *  - `accepted`: the membership the API returned; the source has chosen that organisation.
 *  - `signed-out`: a 401; the session has ended and the source shows it.
 *  - `refused`: the API's code (`invitation_invalid`, a `forbidden` for another address, …); nothing was accepted.
 *  - `unknown`: no usable answer. The invitation is single-use and may have been accepted; the person checks their
 *    organisations rather than opening the link again.
 *  - `stale`: the person changed while it was in flight; nothing is shown. */
export type AcceptOutcome =
	| { readonly kind: 'accepted'; readonly membership: Membership }
	| { readonly kind: 'signed-out' }
	| { readonly kind: 'refused'; readonly status: number; readonly code: string }
	| { readonly kind: 'unknown' }
	| { readonly kind: 'stale' };

export type PasskeyMutation =
	| { readonly kind: 'done' } | { readonly kind: 'stale' }
	| { readonly kind: 'browser'; readonly reason: 'dismissed' | 'exists' | 'unsupported' }
	| { readonly kind: 'failed'; readonly uncertain: boolean; readonly retryAfter: number; readonly code: string };

/** Registration challenge only, never a session token. Kept inside the call, not UI state or storage. */
export function parseRegistration(value: unknown): { token: string; options: unknown } {
	if (!isRecord(value) || !hasExactly(value, ['token', 'options']) || typeof value.token !== 'string' || !/^pkr_[A-Za-z0-9_-]{43}$/.test(value.token) || !isRecord(value.options)) return refuse('registration');
	return { token: value.token, options: value.options };
}
const parseRemoved = (value: unknown): true => {
	if (!isRecord(value) || !hasExactly(value, ['ok']) || value.ok !== true) return refuse('removed passkey');
	return true;
};
export type WebCalls = {
	readonly members: MembersCalls;
	readonly push: PushCalls;
	readonly threads: ThreadCalls;
	/** The one sign-in link (§B.2): `{origin}/auth/google/start?return_to={path}`, a plain navigation in the same tab.
	 *  `returnTo` is kept only as a same-origin path that is not a sign-in page; otherwise `/`. */
	signInUrl(returnTo: string | null): string;
	stepUpOptions(): Promise<ApiOutcome<{ readonly options: unknown }>>;
	stepUpVerify(response: unknown, native?: boolean): Promise<ApiOutcome<{ readonly returnTo: string }>>;
	passkeys(): Promise<ApiOutcome<PasskeyList>>;
	addPasskey(name: string, create: (options: unknown) => Promise<unknown>, active: () => boolean): Promise<PasskeyMutation>;
	removePasskey(id: string): Promise<PasskeyMutation>;
	acceptInvitation(token: string): Promise<AcceptOutcome>;
};

/** The hooks the account source gives these calls: whose account a call is for (compared before and after), and what
 *  to do with an accepted membership or an ended session. */
export type WebCallHooks = {
	/** An opaque account epoch, or null when not signed in. */
	readonly accountEpoch: () => string | null;
	readonly memberScope?: () => MemberScope | null;
	readonly accepted: (membership: Membership) => void;
	readonly sessionEnded: () => void;
	readonly reconcileMemberships?: () => void;
};

const unavailable = <T>(): ApiOutcome<T> => ({ ok: false, kind: 'unavailable', status: 0 });
const settle = async <T>(call: () => Promise<ApiOutcome<T>>): Promise<ApiOutcome<T>> => { try { return await call(); } catch { return unavailable(); } };

/** Where a sign-in may return: a safe same-origin path that is not the welcome, sign-in or step-up page. */
export function returnPath(candidate: string | null): string {
	const safe = safeReturnPath(candidate);
	if (safe === null || safe === '/welcome' || safe.startsWith('/welcome?') || safe.startsWith('/auth/')) return '/';
	return safe;
}

export function createWebCalls(client: ApiClient, origin: string, hooks: WebCallHooks): WebCalls {
	const mutation = (answer: ApiOutcome<unknown>, write: boolean): PasskeyMutation => {
		if (answer.ok) return { kind: 'done' };
		if (answer.kind === 'unauthorised') { hooks.sessionEnded(); return { kind: 'stale' }; }
		return { kind: 'failed', uncertain: write && answer.kind === 'unavailable', retryAfter: answer.kind === 'unavailable' ? answer.retryAfter ?? 0 : 0, code: answer.kind === 'refused' ? answer.code : 'unavailable' };
	};
	return Object.freeze({
		push: createPushCalls(client, { scope: hooks.memberScope ?? (() => null), sessionEnded: hooks.sessionEnded, reconcile: hooks.reconcileMemberships ?? (() => {}) }),
		threads: createThreadCalls(client, { scope: hooks.memberScope ?? (() => null), sessionEnded: hooks.sessionEnded, reconcile: hooks.reconcileMemberships ?? (() => {}) }),
		members: createMembersCalls(client, origin, { scope: hooks.memberScope ?? (() => null), sessionEnded: hooks.sessionEnded, reconcile: hooks.reconcileMemberships ?? (() => {}) }),
		async addPasskey(name: string, create: (options: unknown) => Promise<unknown>, active: () => boolean): Promise<PasskeyMutation> {
			const epoch = hooks.accountEpoch();
			const current = () => epoch !== null && hooks.accountEpoch() === epoch && active();
			if (!current()) return { kind: 'stale' };
			const options = await settle(() => client.post(apiPaths.passkeyRegistrationOptions, null, {}, parseRegistration));
			if (!current()) return { kind: 'stale' };
			if (!options.ok) return mutation(options, false);
			let response: unknown;
			try { response = await create(options.value.options); }
			catch (error) {
				if (!current()) return { kind: 'stale' };
				return { kind: 'browser', reason: error instanceof Error && error.name === 'NotAllowedError' ? 'dismissed' : error instanceof Error && error.name === 'InvalidStateError' ? 'exists' : 'unsupported' };
			}
			if (!current()) return { kind: 'stale' };
			const answer = await settle(() => client.post(apiPaths.passkeys, null, { token: options.value.token, name: name.trim().slice(0, 60), response }, value => parsePasskeys({ available: true, passkeys: [value] })));
			return current() ? mutation(answer, true) : { kind: 'stale' };
		},
		async removePasskey(id: string): Promise<PasskeyMutation> {
			const epoch = hooks.accountEpoch();
			if (epoch === null) return { kind: 'stale' };
			const answer = await settle(() => client.delete(passkeyPath(id), null, parseRemoved));
			return hooks.accountEpoch() === epoch ? mutation(answer, true) : { kind: 'stale' };
		},
		signInUrl: (returnTo: string | null) => `${origin}${googleStartPath}?return_to=${encodeURIComponent(returnPath(returnTo))}`,
		// The step-up token is the `captain_stepup` cookie; the body carries nothing.
		stepUpOptions: () => settle(() => client.post(apiPaths.passkeyOptions, null, {}, parseStepUpOptions)),
		stepUpVerify: (response: unknown, native = false) => settle(() => client.post(apiPaths.passkeyVerify, null, { response }, value => parseStepUpVerified(value, native))),
		async passkeys() {
			const epoch = hooks.accountEpoch();
			if (epoch === null) return unavailable<PasskeyList>();
			const answer = await settle(() => client.get(apiPaths.passkeys, null, parsePasskeys));
			if (hooks.accountEpoch() !== epoch) return unavailable<PasskeyList>();
			if (!answer.ok && answer.kind === 'unauthorised') hooks.sessionEnded();
			return answer;
		},
		async acceptInvitation(token: string): Promise<AcceptOutcome> {
			const epoch = hooks.accountEpoch();
			if (epoch === null || typeof token !== 'string' || token.length === 0 || token.length > 500) return { kind: 'stale' };
			const answer = await settle(() => client.post(apiPaths.acceptInvitation, null, { token }, parseMembership));
			if (hooks.accountEpoch() !== epoch) return { kind: 'stale' };
			if (answer.ok) { hooks.accepted(answer.value); return { kind: 'accepted', membership: answer.value }; }
			if (answer.kind === 'unauthorised') { hooks.sessionEnded(); return { kind: 'signed-out' }; }
			if (answer.kind === 'refused') return { kind: 'refused', status: answer.status, code: answer.code };
			hooks.reconcileMemberships?.();
			return { kind: 'unknown' };
		}
	});
}
