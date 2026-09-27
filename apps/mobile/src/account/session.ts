import { StorageUnreadable, type StorageKey, type StoredSession } from './contracts.ts';

/** Strict parsing of the values the credential store keeps. The schema and every field's format are exact; the JSON
 *  encoding (key order, whitespace, escapes) is not, because it adds no protection. Anything else is unreadable.
 *  Failures never repeat the value. */

const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The API's session token: `sess_` and 32 random bytes in base64url (apps/api/src/auth/service.ts). */
const sessionToken = /^sess_[A-Za-z0-9_-]{43}$/;
/** Date#toJSON output, which is how the API sends `expiresAt`. */
const isoInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const sessionFields = ['expiresAt', 'token', 'userId'];

export const sessionKey = 'session' satisfies StorageKey;
export const organisationKey = (userId: string): StorageKey => `org.${userId}`;

export const isCanonicalUuid = (value: unknown): value is string => typeof value === 'string' && canonicalUuid.test(value);
export const isSessionToken = (value: unknown): value is string => typeof value === 'string' && sessionToken.test(value);

/** A real instant written exactly as Date#toJSON writes it, so `2030-02-30T…` or `…+00:00` are refused. */
const isInstant = (value: unknown): value is string => {
	if (typeof value !== 'string' || !isoInstant.test(value)) return false;
	const time = Date.parse(value);
	return Number.isFinite(time) && new Date(time).toISOString() === value;
};

/** Exactly the three fields, each well formed, on a plain object. */
export function isStoredSession(value: unknown): value is StoredSession {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	const keys = Object.keys(value).sort();
	if (keys.length !== sessionFields.length || keys.some((key, index) => key !== sessionFields[index])) return false;
	const { token, expiresAt, userId } = value as Record<string, unknown>;
	return isSessionToken(token) && isInstant(expiresAt) && isCanonicalUuid(userId);
}

/** A fresh, frozen copy holding only the three fields. */
const copy = (session: StoredSession): StoredSession =>
	Object.freeze({ token: session.token, expiresAt: session.expiresAt, userId: session.userId });

/** The stored string for a session. The caller has checked it with isStoredSession. */
export const serialiseSession = (session: StoredSession): string => JSON.stringify(copy(session));

/** Throws StorageUnreadable unless `raw` is JSON holding exactly a stored session (isStoredSession). */
export function parseStoredSession(raw: string): StoredSession {
	let value: unknown;
	try { value = JSON.parse(raw); } catch { throw new StorageUnreadable(); }
	if (!isStoredSession(value)) throw new StorageUnreadable();
	return copy(value);
}

/** Throws StorageUnreadable unless `raw` is exactly a canonical organisation ID. */
export function parseOrganisationId(raw: string): string {
	if (!isCanonicalUuid(raw)) throw new StorageUnreadable();
	return raw;
}
