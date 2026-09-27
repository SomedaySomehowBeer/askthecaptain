/** `POST /auth/native/exchange` (mobile foundation contract §3.3; docs/plans/expo-mobile-auth-core-2026-09.md; the mapping is in src/api/failure.ts). Sent exactly
 *  once per attempt, whatever happens, and never retried. Pure: the transport is injected. */
import { sessionToken, type Transport } from '../api/client.ts';
import { exchangeOutcome } from '../api/failure.ts';
import { apiPaths } from '../api/paths.ts';
import type { AttemptOutcome, SignedIn } from './contracts.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Date#toJSON output, as the API sends it; the same rule as the credential store's, so an accepted session can be saved. */
const isoInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const isInstant = (value: unknown): value is string => {
	if (typeof value !== 'string' || !isoInstant.test(value)) return false;
	const time = Date.parse(value);
	return Number.isFinite(time) && new Date(time).toISOString() === value;
};
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const hasExactly = (value: Record<string, unknown>, keys: string[]) => {
	const own = Object.keys(value);
	return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
};
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;

/** The exchange's success body, exactly `{ token, expiresAt, user: { id, email, name }, returnTo }` and nothing else.
 *  Throws a TypeError, never naming a value, on anything else. `returnTo` is only checked as text here: the account
 *  runner applies the app's link rule, and a refused one lands on `/work`. */
export function parseSignedIn(value: unknown): SignedIn {
	const refuse = (): never => { throw new TypeError('exchange: the sign-in answer was not in the expected form'); };
	if (!isRecord(value) || !hasExactly(value, ['token', 'expiresAt', 'user', 'returnTo'])) return refuse();
	const { token, expiresAt, user, returnTo } = value;
	if (typeof token !== 'string' || !sessionToken.test(token)) return refuse();
	if (!isInstant(expiresAt)) return refuse();
	if (!isRecord(user) || !hasExactly(user, ['id', 'email', 'name'])) return refuse();
	if (typeof user.id !== 'string' || !uuid.test(user.id) || !text(user.email, 320) || user.email.length === 0 || !text(user.name, 500)) return refuse();
	if (!text(returnTo, 2048)) return refuse();
	return { token, expiresAt, user: { id: user.id, email: user.email, name: user.name }, returnTo };
}

/** Spends the handoff once. A transport that throws (it should not) is `uncertain`: the request may have been sent. */
export async function exchange(transport: Transport, code: string, verifier: string, attempt: string): Promise<AttemptOutcome> {
	try {
		return exchangeOutcome(await transport.request('POST', apiPaths.nativeExchange, null, { code, verifier, attempt }), parseSignedIn);
	} catch {
		return { kind: 'uncertain' };
	}
}
