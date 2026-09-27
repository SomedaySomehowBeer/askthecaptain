import type { SessionUser } from '../auth/contracts.ts';
import { isCanonicalUuid } from './session.ts';

/** Strict parsing of `GET /v1/me` (apps/api/src/app.ts: `{ user, memberships, passkeyVerified }`; memberships from
 *  apps/api/src/organisations/service.ts, active only). Anything else is refused with a fixed TypeError that never
 *  repeats a value; the API client then reports the answer as unavailable, never as a sign-out. */

export type Role = 'owner' | 'admin' | 'member';
export type Membership = { readonly organisationId: string; readonly organisationName: string; readonly role: Role };
export type Me = { readonly user: SessionUser; readonly memberships: readonly Membership[]; readonly passkeyVerified: boolean };

const maxMemberships = 500;
const roles: readonly string[] = ['owner', 'admin', 'member'];

const refuse = (): never => { throw new TypeError('identity: the answer was not in the expected form'); };
const isRecord = (value: unknown): value is Record<string, unknown> => {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
};
/** Exactly these own keys, no more and no fewer. */
const hasExactly = (value: Record<string, unknown>, keys: readonly string[]) => {
	const own = Object.keys(value);
	return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
};
const text = (value: unknown, min: number, max: number): value is string =>
	typeof value === 'string' && value.length >= min && value.length <= max;

function parseMembership(value: unknown): Membership {
	if (!isRecord(value) || !hasExactly(value, ['organisationId', 'organisationName', 'role', 'status'])) return refuse();
	const { organisationId, organisationName, role, status } = value;
	if (!isCanonicalUuid(organisationId) || !text(organisationName, 1, 500)) return refuse();
	if (typeof role !== 'string' || !roles.includes(role) || status !== 'active') return refuse();
	return Object.freeze({ organisationId, organisationName, role: role as Role });
}

/** The person and their active memberships, exactly as the API sends them. A name may be empty (users.name defaults to
 *  ''); an organisation appears at most once. */
export function parseMe(value: unknown): Me {
	if (!isRecord(value) || !hasExactly(value, ['user', 'memberships', 'passkeyVerified'])) return refuse();
	const { user, memberships, passkeyVerified } = value;
	if (typeof passkeyVerified !== 'boolean') return refuse();
	if (!isRecord(user) || !hasExactly(user, ['id', 'email', 'name'])) return refuse();
	if (!isCanonicalUuid(user.id) || !text(user.email, 1, 320) || !text(user.name, 0, 500)) return refuse();
	if (!Array.isArray(memberships) || memberships.length > maxMemberships) return refuse();
	const parsed = memberships.map(parseMembership);
	if (new Set(parsed.map((m) => m.organisationId)).size !== parsed.length) return refuse();
	return Object.freeze({
		user: Object.freeze({ id: user.id, email: user.email, name: user.name }),
		memberships: Object.freeze(parsed),
		passkeyVerified
	});
}
