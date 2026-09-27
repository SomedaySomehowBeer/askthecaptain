/** Every API path the app may request (mobile foundation contract §4 "Transport"; docs/plans/expo-mobile-auth-core-2026-09.md). Pure: no
 *  React Native import. The client builds a URL only as the configured API origin plus one of these paths; nothing
 *  server-supplied is ever used as a URL, so a bearer can only be sent to the API's own routes. */

/** The fixed routes the client calls, by name. */
export const apiPaths = {
	/** Identity and memberships (GET, bearer). */
	me: '/v1/me',
	/** Spends a native handoff for a session (POST, no bearer). */
	nativeExchange: '/auth/native/exchange',
	/** Revokes the presented session (POST, bearer). */
	signOut: '/auth/sign-out'
} as const;
export type FixedApiPath = (typeof apiPaths)[keyof typeof apiPaths];

/** The sign-in start, opened in the platform authentication browser, never requested by the client (§3.2 step 1). */
export const nativeStartPath = '/auth/google/start';

declare const organisationPathBrand: unique symbol;
/** A path under one organisation. Only organisationPath makes these, so no other code assembles one from strings. */
export type OrganisationPath = string & { readonly [organisationPathBrand]: true };
export type ApiPath = FixedApiPath | OrganisationPath;

const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const maxSegmentLength = 200;

/** `/v1/organisations/{organisationId}` followed by each segment as its own path segment.
 *  - `organisationId` must be a canonical, lower-case UUID, as the API returns it.
 *  - Each segment must be a non-empty string of at most 200 characters, and not `.` or `..`.
 *  - Each segment is encodeURIComponent-encoded, so `/`, `?`, `#` and `%` inside it stay inside that segment and can't
 *    change the path, add a query or a fragment.
 *  Throws a TypeError that never repeats the rejected value. */
export function organisationPath(organisationId: string, ...segments: string[]): OrganisationPath {
	if (typeof organisationId !== 'string' || !canonicalUuid.test(organisationId)) throw new TypeError('organisation path: the organisation ID is not a canonical UUID');
	const encoded = segments.map((segment) => {
		if (typeof segment !== 'string' || segment.length === 0 || segment.length > maxSegmentLength || segment === '.' || segment === '..')
			throw new TypeError('organisation path: a path segment is empty, too long, or a dot segment');
		return encodeURIComponent(segment);
	});
	return ['/v1/organisations', organisationId, ...encoded].join('/') as OrganisationPath;
}
