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
	signOut: '/auth/sign-out',
	/** Ends the person's other sessions and keeps the presented one (POST, bearer, no input;
	 *  docs/plans/mobile-session-revocation-2026-09.md §2). */
	revokeOthers: '/v1/me/sessions/revoke-others',
	/** The passkey step-up's assertion options (POST). On the web the step-up token travels in the `captain_stepup`
	 *  cookie, so the body is empty (docs/plans/expo-web-session-2026-09.md §A.2). */
	passkeyOptions: '/auth/passkey/options',
	/** The browser's assertion (POST `{ response }`); a verified passkey sets the session cookie. */
	passkeyVerify: '/auth/passkey/verify',
	/** The person's registered passkeys (GET, signed in). */
	passkeys: '/v1/me/passkeys',
	/** Accepts an invitation the signed-in person was sent (POST `{ token }`, signed in). */
	acceptInvitation: '/v1/invitations/accept'
} as const;
export type FixedApiPath = (typeof apiPaths)[keyof typeof apiPaths];

/** The sign-in start: opened in the platform authentication browser on iOS and Android (§3.2 step 1), and the web
 *  welcome page's one link (docs/plans/expo-web-session-2026-09.md §B.2). Never requested by the client. */
export const googleStartPath = '/auth/google/start';
export const nativeStartPath = googleStartPath;

declare const organisationPathBrand: unique symbol;
/** A path under one organisation. Only organisationPath and the fixed equipment query builders make these. */
export type OrganisationPath = string & { readonly [organisationPathBrand]: true };
export type ApiPath = FixedApiPath | OrganisationPath;

const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const maxSegmentLength = 200;

/** Whether `value` is a canonical, lower-case UUID, as the API returns IDs. */
export const isCanonicalUuid = (value: unknown): value is string => typeof value === 'string' && canonicalUuid.test(value);

const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** Whether `value` is a canonical API instant: exactly what `Date.prototype.toISOString()` produces for years 0000–9999
 *  (`2026-09-27T00:00:00.000Z`). The API serialises every `Date` this way, so anything else (no milliseconds, an offset,
 *  a calendar date that doesn't exist) is not an API instant (docs/plans/expo-mobile-equipment-read-2026-09.md §4.3). */
export function isCanonicalInstant(value: unknown): value is string {
	if (typeof value !== 'string' || !instantPattern.test(value)) return false;
	const time = Date.parse(value);
	return Number.isFinite(time) && new Date(time).toISOString() === value;
}

/** The API's instant bounds for reservation windows and actual reservation times: at or after 1900-01-01T00:00Z and
 *  strictly before 2200-01-01T00:00Z (apps/api/src/equipment/service.ts `instant`). */
export const apiEarliestInstant = Date.UTC(1900, 0, 1);
export const apiLatestInstant = Date.UTC(2200, 0, 1);
export const dayMs = 86_400_000;
/** The longest occupancy window the API reads (`reservationsQuery`). */
export const maxOccupancyWindowMs = 93 * dayMs;
/** Equipment catalogue page size: the API maximum, requested explicitly. */
export const equipmentPageSize = 100;
/** The API's largest accepted catalogue `offset` (`equipmentQuery`). */
export const maxEquipmentOffset = 1_000_000;
/** Occupancy rows per read: the API maximum. Mobile always reads offset 0 and never pages within a window. */
export const occupancyPageSize = 200;

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

/** One page of active equipment (docs/plans/expo-mobile-equipment-read-2026-09.md §4.5): `limit=100` and `offset`, in
 *  that fixed order. `archived` is omitted, so the API returns active equipment only.
 *  - `offset` must be an integer multiple of 100 from 0 to the API's maximum offset.
 *  Throws a TypeError that never repeats a rejected value. */
export function equipmentPagePath(scope: ScopeIds, offset: number): OrganisationPath {
	if (typeof scope !== 'object' || scope === null) throw new TypeError('equipment path: no scope');
	if (!Number.isInteger(offset) || offset < 0 || offset > maxEquipmentOffset || offset % equipmentPageSize !== 0)
		throw new TypeError('equipment path: the offset is not a catalogue page');
	return `${organisationPath(scope.organisationId, 'equipment')}?limit=${equipmentPageSize}&offset=${offset}` as OrganisationPath;
}

/** A half-open occupancy window `[from, to)` as canonical API instants. A range chunk satisfies this structurally. */
export type OccupancyWindow = { readonly from: string; readonly to: string };

/** Confirmed occupancy of one equipment in one window (§4.2): `from`, `to` and `limit=200`, in that fixed order.
 *  - `equipmentId` must be a canonical lower-case UUID.
 *  - `from` and `to` must be canonical API instants (`…sssZ`, never an offset, so no value needs encoding and the
 *    transport's exact response-URL check stays meaningful), each inside the API's 1900–2200 bounds, with
 *    `0 < to − from ≤ 93 days`.
 *  Throws a TypeError that never repeats a rejected value. */
export function occupancyPath(scope: ScopeIds, equipmentId: string, span: OccupancyWindow): OrganisationPath {
	if (typeof scope !== 'object' || scope === null) throw new TypeError('occupancy path: no scope');
	if (!isCanonicalUuid(equipmentId)) throw new TypeError('occupancy path: the equipment ID is not a canonical UUID');
	if (typeof span !== 'object' || span === null) throw new TypeError('occupancy path: no window');
	const { from, to } = span;
	if (!isCanonicalInstant(from) || !isCanonicalInstant(to)) throw new TypeError('occupancy path: the window is not two canonical instants');
	const low = Date.parse(from), high = Date.parse(to);
	if (low < apiEarliestInstant || high >= apiLatestInstant || high <= low || high - low > maxOccupancyWindowMs)
		throw new TypeError('occupancy path: the window is outside the API bounds');
	return `${organisationPath(scope.organisationId, 'equipment', equipmentId, 'reservations')}?from=${from}&to=${to}&limit=${occupancyPageSize}` as OrganisationPath;
}
