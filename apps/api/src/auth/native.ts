import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Sql, TransactionSql } from '@captain/db';
import { z } from 'zod';
import { HttpError, badRequest } from '../errors.ts';

/** Native sign-in (docs/plans/expo-mobile-foundation-2026-09.md §3). A mobile app runs the ordinary Google and
 *  passkey flow in the platform's authentication browser. At the end it receives a one-time `native_handoff`
 *  code, not a session. The app spends that code here, together with the PKCE verifier and attempt it never
 *  sent through a browser. The whole path is off unless NATIVE_SIGN_IN=1, and every leg checks that again.
 *  This file imports nothing from the other auth modules, so they can import it without an import cycle. */

type Db = Sql | TransactionSql;
/** The app's S256 challenge and attempt: 32 random bytes each, base64url, 43 characters. */
const value = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const nativeContext = z.object({ challenge: value, attempt: value }).strict();
export type NativeContext = z.infer<typeof nativeContext>;
export const handoffPayload = z.object({ challenge: value, attempt: value, returnTo: z.string(), passkeyVerified: z.boolean() }).strict();
export type HandoffPayload = z.infer<typeof handoffPayload>;

export const nativeDisabled = () => new HttpError(401, 'native_sign_in_disabled', 'Mobile sign-in is not available on this Captain. Start sign-in again.');
const invalidStart = () => badRequest('native_request_invalid', 'That mobile sign-in request is not valid. Start again from the app.');

const nativeKeys = ['client', 'code_challenge', 'code_challenge_method', 'attempt'];
const allowedKeys = new Set([...nativeKeys, 'return_to']);

/** Reads the query of GET /auth/google/start.
 *  - No native key present: the web flow, exactly as before (the first `return_to`, nothing else inspected).
 *  - Any native key present: refused while the flag is off, before anything is stored. Otherwise strict:
 *    only the five known keys, each given once, `client=native`, method `S256`, and a 43-character challenge
 *    and attempt. The return path is still checked by the caller with the unchanged `safeReturnPath`. */
export function parseStart(query: Record<string, string[]>, enabled: boolean): { returnTo?: string; native?: NativeContext } {
	if (!nativeKeys.some((key) => key in query)) return { returnTo: query.return_to?.[0] };
	if (!enabled) throw badRequest('native_sign_in_unavailable', 'Mobile sign-in is not available on this Captain.');
	for (const [key, values] of Object.entries(query)) if (!allowedKeys.has(key) || values.length !== 1) throw invalidStart();
	if (query.client?.[0] !== 'native' || query.code_challenge_method?.[0] !== 'S256') throw invalidStart();
	const native = nativeContext.safeParse({ challenge: query.code_challenge?.[0], attempt: query.attempt?.[0] });
	if (!native.success) throw invalidStart();
	return { returnTo: query.return_to?.[0], native: native.data };
}

/** The body of POST /auth/native/exchange. The code's shape is checked here. The verifier and attempt are only
 *  bounded: a wrong value is a mismatch that burns the code, not a malformed request. */
export const nativeExchangeInput = z.object({
	code: z.string().regex(/^nh_[A-Za-z0-9_-]{43}$/), verifier: z.string().min(1).max(128), attempt: z.string().min(1).max(128)
}).strict();

/** RFC 7636 S256: base64url(SHA-256(verifier)). */
export const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
/** Equality in constant time over fixed-length digests, so neither the length nor the content leaks. */
export function sameSecret(a: string, b: string): boolean {
	const digest = (v: string) => createHash('sha256').update(v).digest();
	return timingSafeEqual(digest(a), digest(b));
}

/** Stores a two-minute handoff inside the caller's transaction and returns the code. Only the code's hash is
 *  stored, as with every auth request. The code goes back to the web, which passes it to the app. */
export async function insertHandoff(tx: Db, userId: string, payload: HandoffPayload): Promise<string> {
	const code = `nh_${randomBytes(32).toString('base64url')}`;
	await tx`insert into auth_requests (kind, token_hash, user_id, payload, expires_at)
		values ('native_handoff', ${createHash('sha256').update(code).digest('hex')}, ${userId}, ${tx.json(handoffPayload.parse(payload))}, ${new Date(Date.now() + 2 * 60_000)})`;
	return code;
}

/** Serialises "does this person have a passkey?" against passkey registration for the same person. It is a
 *  transaction-scoped advisory lock, released at commit or rollback. */
export async function lockPasskeys(tx: Db, userId: string): Promise<void> {
	await tx`select pg_advisory_xact_lock(hashtextextended(${passkeyLockName(userId)}, 0))`;
}
/** The advisory lock's name before hashing. It is exported so a test can find that exact lock in `pg_locks`. */
export const passkeyLockName = (userId: string) => `captain.passkeys:${userId}`;
