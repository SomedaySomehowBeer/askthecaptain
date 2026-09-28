/** Strict, minimal parsers for the read-only equipment schedule (docs/plans/expo-mobile-equipment-read-2026-09.md §4.1,
 *  §4.3). Pure: no React Native import.
 *
 *  - Each parser throws one fixed TypeError that never repeats a value; the client then reports the read unavailable.
 *    One bad row refuses the whole answer, so a partial answer never looks complete.
 *  - Answers are checked against the exact request they answer (organisation, catalogue page, occupancy window).
 *  - Output is frozen and keeps only the fields the schedule shows. Person, project and task fields are never kept.
 *  - A well-formed occupancy answer in another organisation time zone is reported as `zone-changed`, not as invalid,
 *    and carries none of its rows. */
import type { Parse } from '../../auth/contracts.ts';
import {
	apiEarliestInstant, apiLatestInstant, dayMs, equipmentPageSize, isCanonicalInstant, isCanonicalUuid, maxEquipmentOffset,
	maxOccupancyWindowMs, occupancyPageSize, type OccupancyWindow
} from '../../api/paths.ts';

/** The organisation's time zone name, as stored (a free 1–64 character string; the zone gate decides if it's usable). */
export type OrganisationZone = { readonly timezone: string };

/** One active equipment, in the API's order. `name` is kept raw. */
export type Equipment = { readonly id: string; readonly name: string };
export type EquipmentPageRequest = { readonly offset: number; readonly limit: number };
/** One catalogue page. `nextOffset` is null on the last page, otherwise exactly `offset + limit`. */
export type EquipmentPage = { readonly equipment: readonly Equipment[]; readonly nextOffset: number | null };

export type ReservationKind = 'booking' | 'maintenance';
/** One confirmed reservation, reduced to what the schedule draws. Instants are canonical `…sssZ` strings, exactly as
 *  the API sent them. The occupied interval includes setup and cleanup and may extend beyond the API's 1900–2200 bounds
 *  on actual time. */
export type Reservation = {
	readonly id: string;
	readonly title: string;
	readonly kind: ReservationKind;
	readonly startsAt: string;
	readonly endsAt: string;
	readonly occupiedStartsAt: string;
	readonly occupiedEndsAt: string;
	readonly setupMinutes: number;
	readonly cleanupMinutes: number;
	readonly revision: number;
};
/** What one occupancy read asked for: the equipment, the exact window, and the bootstrapped organisation zone. */
export type OccupancyRequest = OccupancyWindow & { readonly equipmentId: string; readonly zone: string };
export type Coverage = 'complete' | 'partial';
/** A usable occupancy answer. `complete` means every confirmed reservation in the window was returned at the time of
 *  the read; `partial` means exactly 200 were returned and more exist, so gaps are not confirmed free. */
export type OccupancyRead = { readonly kind: 'read'; readonly coverage: Coverage; readonly reservations: readonly Reservation[] };
/** A well-formed answer in a different organisation time zone: nothing from it may be applied (§4.1). */
export type OccupancyZoneChanged = { readonly kind: 'zone-changed' };
export type OccupancyAnswer = OccupancyRead | OccupancyZoneChanged;

const maxZoneLength = 64;
const maxEquipmentName = 100;
const maxTitle = 200;
const maxBufferMinutes = 10_080;
const minuteMs = 60_000;
const maxActualMs = 366 * dayMs;
const zoneChanged: OccupancyZoneChanged = Object.freeze({ kind: 'zone-changed' });

function invalid(): never {
	throw new TypeError('Equipment schedule response is not valid');
}
function record(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
	return value as Record<string, unknown>;
}
function zoneName(value: unknown): string {
	if (typeof value !== 'string' || value.length < 1 || value.length > maxZoneLength) invalid();
	return value;
}
/** A kept text: a string, non-blank after trimming, at most `max` UTF-16 units before trimming, returned raw. */
function text(value: unknown, max: number): string {
	if (typeof value !== 'string' || value.length > max || !value.trim()) invalid();
	return value;
}
function instant(value: unknown): number {
	if (!isCanonicalInstant(value)) invalid();
	return Date.parse(value);
}
function bufferMinutes(value: unknown): number {
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > maxBufferMinutes) invalid();
	return value;
}

/** `GET /v1/organisations/{id}`: the answer must be for `organisationId`. Only `timezone` is kept (§4.1). */
export function parseOrganisationZone(value: unknown, organisationId: string): OrganisationZone {
	if (!isCanonicalUuid(organisationId)) invalid();
	const body = record(value);
	if (body.id !== organisationId) invalid();
	return Object.freeze({ timezone: zoneName(body.timezone) });
}

/** `GET …/equipment?limit&offset` (§4.3): at most `limit` active equipment with unique canonical IDs, non-blank names of
 *  at most 100 characters, `archivedAt: null`; `nextOffset` null, or exactly `offset + limit` with the page full. */
export function parseEquipmentPage(value: unknown, request: EquipmentPageRequest): EquipmentPage {
	const { offset, limit } = request;
	if (!Number.isInteger(limit) || limit < 1 || limit > equipmentPageSize || !Number.isInteger(offset) || offset < 0 || offset > maxEquipmentOffset)
		invalid();
	const body = record(value);
	const rows = body.equipment;
	if (!Array.isArray(rows) || rows.length > limit) invalid();
	const seen = new Set<string>();
	const equipment: Equipment[] = [];
	for (const raw of rows) {
		const item = record(raw);
		const id = item.id;
		if (!isCanonicalUuid(id) || seen.has(id)) invalid();
		const name = text(item.name, maxEquipmentName);
		if (item.archivedAt !== null) invalid();
		seen.add(id);
		equipment.push(Object.freeze({ id, name }));
	}
	const next = body.nextOffset;
	let nextOffset: number | null = null;
	if (next !== null) {
		if (next !== offset + limit || rows.length !== limit) invalid();
		nextOffset = offset + limit;
	}
	return Object.freeze({ equipment: Object.freeze(equipment), nextOffset });
}

/** The request's own bounds, as the path builder enforces them; a bad request is a client bug and refuses the answer. */
function requestWindow(request: OccupancyRequest): { readonly low: number; readonly high: number } {
	if (typeof request !== 'object' || request === null || !isCanonicalUuid(request.equipmentId)) invalid();
	zoneName(request.zone);
	const low = instant(request.from), high = instant(request.to);
	if (low < apiEarliestInstant || high >= apiLatestInstant || high <= low || high - low > maxOccupancyWindowMs) invalid();
	return { low, high };
}

function reservation(raw: unknown, equipmentId: string, low: number, high: number, seen: Set<string>): Reservation {
	const row = record(raw);
	const id = row.id;
	if (!isCanonicalUuid(id) || seen.has(id)) invalid();
	if (row.equipmentId !== equipmentId || row.status !== 'confirmed') invalid();
	const title = text(row.title, maxTitle);
	const kind: ReservationKind = row.kind === 'booking' ? 'booking' : row.kind === 'maintenance' ? 'maintenance' : invalid();
	const startsAt = instant(row.startsAt), endsAt = instant(row.endsAt);
	const occupiedStartsAt = instant(row.occupiedStartsAt), occupiedEndsAt = instant(row.occupiedEndsAt);
	// Actual time is inside the API's bounds and at most 366 days long; occupied time may extend beyond the bounds by
	// its buffers, and must equal actual time widened by exactly those buffers.
	if (startsAt < apiEarliestInstant || endsAt >= apiLatestInstant || endsAt <= startsAt || endsAt - startsAt > maxActualMs) invalid();
	const setupMinutes = bufferMinutes(row.setupMinutes), cleanupMinutes = bufferMinutes(row.cleanupMinutes);
	if (occupiedStartsAt !== startsAt - setupMinutes * minuteMs || occupiedEndsAt !== endsAt + cleanupMinutes * minuteMs) invalid();
	if (occupiedStartsAt >= high || occupiedEndsAt <= low) invalid();
	const revision = row.revision;
	if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) invalid();
	seen.add(id);
	return Object.freeze({
		id, title, kind,
		startsAt: row.startsAt as string, endsAt: row.endsAt as string,
		occupiedStartsAt: row.occupiedStartsAt as string, occupiedEndsAt: row.occupiedEndsAt as string,
		setupMinutes, cleanupMinutes, revision
	});
}

/** `GET …/equipment/{id}/reservations?from&to&limit=200` (§4.3). The answer must echo the exact window, and its page
 *  facts must be one of the two combinations the API produces at offset 0:
 *  - `coverage: 'complete'` with `nextOffset: null` and at most 200 rows;
 *  - `coverage: 'partial'` with `nextOffset: 200` and exactly 200 rows.
 *  Every row is validated before the zone is compared, so a malformed answer is never reported as a zone change. */
export function parseOccupancy(value: unknown, request: OccupancyRequest): OccupancyAnswer {
	const { low, high } = requestWindow(request);
	const body = record(value);
	if (body.from !== request.from || body.to !== request.to) invalid();
	const timezone = zoneName(body.timezone);
	const rows = body.reservations;
	if (!Array.isArray(rows) || rows.length > occupancyPageSize) invalid();
	let coverage: Coverage;
	if (body.coverage === 'complete' && body.nextOffset === null) coverage = 'complete';
	else if (body.coverage === 'partial' && body.nextOffset === occupancyPageSize && rows.length === occupancyPageSize) coverage = 'partial';
	else invalid();
	const seen = new Set<string>();
	const reservations = rows.map((raw) => reservation(raw, request.equipmentId, low, high, seen));
	if (timezone !== request.zone) return zoneChanged;
	return Object.freeze({ kind: 'read', coverage, reservations: Object.freeze(reservations) });
}

/** The same parsers bound to their request, as the runner's `Parse<T>`. */
export const organisationZoneParser = (organisationId: string): Parse<OrganisationZone> => (value) => parseOrganisationZone(value, organisationId);
export const equipmentPageParser = (request: EquipmentPageRequest): Parse<EquipmentPage> => (value) => parseEquipmentPage(value, request);
export const occupancyParser = (request: OccupancyRequest): Parse<OccupancyAnswer> => (value) => parseOccupancy(value, request);
