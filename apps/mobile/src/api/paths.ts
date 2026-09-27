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
/** A path under one organisation. Only organisationPath and the fixed work-list query builders make these. */
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

/** The IDs a business read is scoped to. The account's `ReadScope` (src/account/contracts.ts) adds an opaque `epoch`
 *  and satisfies this structurally; this module does not import the account layer. */
export type ScopeIds = { readonly userId: string; readonly organisationId: string };

export type WorkView = 'mine' | 'all';
/** Work page size, as on the web (apps/web/src/app/work/filters.ts `pageSize`). */
export const workPageSize = 50;
/** The most pages one Work list screen loads per mount (docs/plans/expo-mobile-my-work-read-2026-09.md §3.5). */
export const maxWorkPages = 10;

/** Fixed Work queries: My work includes ownerId; All tasks omits it. Both explicitly ask for status=open.
 * The My work query matches the web
 *  (docs/plans/expo-mobile-my-work-read-2026-09.md §3.3).
 *  - Both IDs must be canonical lower-case UUIDs; `offset` an integer multiple of 50 within the page cap.
 *  - The keys are fixed and in a fixed order, and no value needs percent-encoding, so the transport's exact
 *    response-URL check stays meaningful.
 *  Throws a TypeError that never repeats a rejected value. */
export function workListPath(scope: ScopeIds, view: WorkView, offset: number): OrganisationPath {
	if (view !== 'mine' && view !== 'all') throw new TypeError('work path: unsupported view');
	if (typeof scope !== 'object' || scope === null) throw new TypeError('work path: no scope');
	const userId = scope.userId;
	if (typeof userId !== 'string' || !canonicalUuid.test(userId)) throw new TypeError('work path: the user ID is not a canonical UUID');
	if (!Number.isInteger(offset) || offset < 0 || offset % workPageSize !== 0 || offset > workPageSize * (maxWorkPages - 1))
		throw new TypeError('work path: the offset is not a page within the cap');
	const base = organisationPath(scope.organisationId, 'tasks');
	const owner = view === 'mine' ? `ownerId=${userId}&` : '';
	return `${base}?${owner}status=open&offset=${offset}&limit=${workPageSize}` as OrganisationPath;
}

/** My work retains its exact query while sharing validation with All tasks. */
export const myWorkPath = (scope: ScopeIds, offset: number): OrganisationPath => workListPath(scope, 'mine', offset);
