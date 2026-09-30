/** Native sign-in protocol interfaces (mobile foundation contract §3.2 steps 5–7, §3.3, §4; implementation plan
 *  docs/plans/expo-mobile-auth-core-2026-09.md).
 *  Types only, plus the one error the interface names. Pure: no React Native or Expo import. The attempt core, the API
 *  client and the platform adapters implement these in later reviewed increments.
 *
 *  Tokens: `SignedIn.token` is the only place a session token appears here. It is handed to the account runner, which
 *  keeps it behind an opaque handle; it never enters reducer state, UI state, logs or storage other than the credential
 *  store. Nothing in this file carries a handoff code, PKCE verifier or attempt value outward. */
import type { ApiPath } from '../api/paths.ts';

export type { ApiPath, FixedApiPath, OrganisationPath } from '../api/paths.ts';

/** Platform services the attempt core needs, injected so the core never imports expo-*. */
export type AuthPlatform = {
	/** Cryptographically random bytes (expo-crypto). */
	randomBytes(length: 32): Promise<Uint8Array>;
	/** SHA-256 over raw bytes (expo-crypto). */
	sha256(data: Uint8Array): Promise<Uint8Array>;
	/** `openAuthSessionAsync(url, redirectPrefix, { preferEphemeralSession: true })`. Every result other than
	 *  `success` (cancel, dismiss, locked, Android's opened, or any future type) is treated as cancelled. */
	openAuthSession(url: string, redirectPrefix: string): Promise<{ type: 'success'; url: string } | { type: string }>;
	dismissAuthSession(): void;
};

export type SessionUser = { id: string; email: string; name: string };
/** A successful native exchange. Goes to the account runner only. */
export type SignedIn = { token: string; expiresAt: string; user: SessionUser; returnTo: string };

/** One attempt's result. There is only ever one attempt at a time. */
export type AttemptOutcome =
	| { kind: 'signed-in'; session: SignedIn }
	/** Any non-success browser result before a callback. Nothing was sent; says nothing about why. */
	| { kind: 'cancelled' }
	/** The browser returned something other than this attempt's exact callback. Nothing was sent. */
	| { kind: 'callback-invalid' }
	/** /auth/native/exchange answered 401 with code native_sign_in_disabled. */
	| { kind: 'native-disabled' }
	/** /auth/native/exchange answered any other 401 (expired, used, wrong binding, passkey now required), 400, or any
	 *  other 4xx except 429. Also: the platform's crypto failed before anything was sent. */
	| { kind: 'cannot-finish' }
	/** /auth/native/exchange answered 429 or 5xx. The code is never sent twice. The wording makes no claim that no
	 *  session was created: a proxy's 5xx can follow a committed exchange. */
	| { kind: 'start-again'; status: number }
	/** The exchange was sent and no usable answer arrived: network error, timeout, a redirect, a 2xx whose body was
	 *  unreadable or malformed, or any other status. It is never re-sent. */
	| { kind: 'uncertain' };
export type AttemptKind = AttemptOutcome['kind'];

/** The attempt lifecycle. `start()` is refused unless `idle`; `cancel()` works only in `opening` or `awaiting-callback`.
 *  `closing`: cancelled, and waiting for the platform call already under way (crypto or the browser) to settle, so a new
 *  attempt never overlaps the old browser; if it never settles the state stays `closing`, and the runner bounds that
 *  wait. `cleaning-up` and `cleanup-pending` hold a late success's token privately until it is revoked (a guard that is
 *  unreachable through this interface; see src/auth/attempt.ts). */
export type AttemptState = 'idle' | 'opening' | 'awaiting-callback' | 'exchanging' | 'closing' | 'cleaning-up' | 'cleanup-pending';

/** Thrown by `start()` when an attempt is already active or a cleanup is pending. */
export class AttemptActive extends Error {
	constructor() { super('a sign-in attempt is already in progress'); this.name = 'AttemptActive'; }
}

/** Called only by the account effect runner, never by UI. The runner offers sign-in only when all of these hold: its
 *  own cleanup has settled; this core's `state()` is exactly `idle` (so not `opening`, `awaiting-callback`,
 *  `exchanging`, `closing`, `cleaning-up` or `cleanup-pending`); and the credential store's `settled()` answered
 *  `settled`. */
export type Attempts = {
	state(): AttemptState;
	/** `returnTo` is included in the start URL only if it is an unchanged same-origin path that opens an app route.
	 *  Throws AttemptActive unless idle; otherwise never rejects. */
	start(returnTo?: string): Promise<AttemptOutcome>;
	/** True only in `opening` or `awaiting-callback`: discards the attempt, dismisses the browser and moves to `closing`;
	 *  `start()` then resolves `cancelled` once the platform call settles, and the state returns to `idle`. */
	cancel(): boolean;
	/** Only in `cleanup-pending`, and only once the server's not-before time (its `retry-after`, reported by
	 *  `pendingCleanupRetryAfterMs()`) has passed: exactly one more revocation send, started by the person. Before the
	 *  not-before time, or while a cleanup is running, it answers 'still-pending' without sending; with nothing held it
	 *  answers 'revoked' without sending. */
	retryCleanup(): Promise<'revoked' | 'still-pending'>;
	/** The held session's expiry, never the token. Not shown to people (no expiry-date wording, composition plan §4.3).
	 *  Passing this time on the device clock is not revocation; only the server's confirmation ends a cleanup. */
	pendingCleanupExpiresAt(): string | null;
	/** While a cleanup is held and the server asked to wait: the milliseconds, on the injected monotonic clock, before
	 *  `retryCleanup()` will send (not a secret). Null when nothing is held or a retry may send now. Cleared when the
	 *  cleanup completes. A long server back-off means a long `cleanup-pending`; the runner turns this duration into a
	 *  monotonic deadline for pacing and an approximate wall time for wording, with the Try again action. */
	pendingCleanupRetryAfterMs(): number | null;
};

/** The result of any client request other than the native exchange. */
export type ApiOutcome<T> =
	| { ok: true; value: T }
	/** A confirmed 401 only. */
	| { ok: false; kind: 'unauthorised' }
	/** Status 0 (network, timeout, a redirect or a response from another URL), 429, 5xx, a 2xx whose body doesn't
	 *  parse, or any other non-4xx status. */
	| { ok: false; kind: 'unavailable'; status: number; retryAfter?: number }
	/** Any other 4xx, by the API's error code. */
	| { ok: false; kind: 'refused'; status: number; code: string };
export type ApiOutcomeKind = Extract<ApiOutcome<unknown>, { ok: false }>['kind'] | 'ok';

/** Parses a successful JSON body strictly; throws when the shape is not the expected one (treated as unavailable). */
export type Parse<T> = (value: unknown) => T;

/** The only fetch path. URLs are always the configured API origin plus an ApiPath; every request is sent with
 *  `redirect: 'error'` (not claimed to protect the bearer on native until the device check passes). The token is
 *  passed per request by the account runner, so the client holds none. No request is retried automatically. */
export type ApiClient = {
	delete<T>(path: ApiPath, token: string | null, parse: Parse<T>): Promise<ApiOutcome<T>>;
	get<T>(path: ApiPath, token: string | null, parse: Parse<T>): Promise<ApiOutcome<T>>;
	post<T>(path: ApiPath, token: string | null, body: unknown, parse: Parse<T>): Promise<ApiOutcome<T>>;
};
