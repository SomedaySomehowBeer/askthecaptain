/** Raw synthetic equipment schedule answers for the test harness (docs/plans/expo-mobile-equipment-read-2026-09.md §6, §7
 *  "Harness fixtures and controls"). Not a route. Each body is in the API's own shape, with fields the parser drops
 *  (`name`, `projectId`, `ownerId`, `createdBy`, `notes`), so the production parser's minimisation runs in the browser.
 *  The fixture is chosen by the read's own path: the organisation, a catalogue page (its `offset`) or one equipment's
 *  occupancy (its `equipmentId`, `from` and `to`, echoed exactly so the parser's window check passes). The control
 *  chooses the variant; a control without a body for that kind answers as an unreadable body (`unavailable`). */

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const instant = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z';
export const organisationPathPattern = new RegExp(`^/v1/organisations/(${uuid})$`);
export const equipmentPagePathPattern = new RegExp(`^/v1/organisations/${uuid}/equipment\\?limit=100&offset=(\\d+)$`);
export const occupancyPathPattern = new RegExp(`^/v1/organisations/${uuid}/equipment/(${uuid})/reservations\\?from=(${instant})&to=(${instant})&limit=200$`);

export const equipmentControls = [
	'equipment-ok', 'equipment-empty', 'equipment-more', 'equipment-partial', 'equipment-conflict-a', 'equipment-conflict-b',
	'equipment-zone-perth', 'equipment-zone-bogus', 'equipment-malformed'
] as const;
export type EquipmentControl = (typeof equipmentControls)[number];
export const isEquipmentControl = (control: string): control is EquipmentControl => (equipmentControls as readonly string[]).includes(control);
/** Whether `path` is one of the schedule's three reads. */
export const isEquipmentPath = (path: string): boolean =>
	organisationPathPattern.test(path) || equipmentPagePathPattern.test(path) || occupancyPathPattern.test(path);

export const equipmentId = (n: number) => `00000000-0000-4000-c000-${String(n).padStart(12, '0')}`;
/** Fixed IDs: the conflict pair (900) and the malformed row (999). Ordinary rows use `rowId`. */
export const reservationId = (n: number) => `00000000-0000-4000-b000-${String(n).padStart(12, '0')}`;
/** 88 UTF-16 units, inside the API's 100. */
export const longEquipmentName = 'Sample equipment name '.repeat(4).trimEnd();
export const harnessZone = 'Australia/Sydney';
const hour = 3_600_000, minute = 60_000;

const zoneFor = (control: EquipmentControl): string =>
	control === 'equipment-zone-perth' ? 'Australia/Perth' : control === 'equipment-zone-bogus' ? 'Nowhere/Land' : harnessZone;

function organisationBody(control: EquipmentControl, organisationId: string): unknown {
	if (control === 'equipment-malformed') return { id: organisationId, name: 'Synthetic organisation', timezone: 7 };
	return { id: organisationId, name: 'Harbour Brewing', timezone: zoneFor(control), createdAt: '2026-01-01T00:00:00.000Z', plan: 'Synthetic plan must not enter state' };
}

const equipmentRow = (n: number, name: string) =>
	({ id: equipmentId(n), name, archivedAt: null, notes: 'Synthetic note must not enter state', createdBy: 'Synthetic person' });
/** Page 0 of `equipment-ok`: three columns, one with a long name. `equipment-more`: a full page 0 (100 rows, `nextOffset`
 *  100) and a page 1 that repeats two IDs already shown (the "list changed" notice) before three new ones. */
function equipmentPageBody(control: EquipmentControl, offset: number): unknown {
	if (control === 'equipment-malformed') return { equipment: [{ id: 'not-a-uuid', name: '' }], nextOffset: null };
	if (control === 'equipment-empty') return { equipment: [], nextOffset: null };
	if (control === 'equipment-more') {
		if (offset === 0) return { equipment: Array.from({ length: 100 }, (_, i) => equipmentRow(i + 1, `Sample vessel ${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`)), nextOffset: 100 };
		if (offset === 100) return { equipment: [equipmentRow(1, 'Sample vessel AA'), equipmentRow(2, 'Sample vessel AB'), equipmentRow(101, 'Sample kettle'), equipmentRow(102, 'Sample chiller'), equipmentRow(103, 'Sample filler')], nextOffset: null };
		return { equipment: [], nextOffset: null };
	}
	if (offset !== 0) return { equipment: [], nextOffset: null };
	return { equipment: [equipmentRow(1, 'Sample fermenter'), equipmentRow(2, 'Sample bright tank'), equipmentRow(3, longEquipmentName)], nextOffset: null };
}

type Row = Record<string, unknown>;
const iso = (ms: number) => new Date(ms).toISOString();
/** The synthetic equipment's index (`equipmentId(n)`), or a hash of a real UUID, so IDs differ per equipment. */
const equipmentIndex = (equipment: string): number => {
	const own = /^00000000-0000-4000-c000-(\d{12})$/.exec(equipment);
	if (own) return Number(own[1]);
	let hash = 7;
	for (const ch of equipment) hash = (hash * 31 + ch.charCodeAt(0)) % 1_000_000;
	return 500_000 + hash;
};
/** A reservation ID for (equipment, key). The same key from adjacent windows gives the same ID, so a booking spanning a
 *  chunk boundary is returned identically by both cells and deduplicated, never contradicted (A's review S5). */
const rowId = (equipment: string, key: number) => `00000000-0000-4000-b${String(equipmentIndex(equipment) % 1000).padStart(3, '0')}-${String(key % 1_000_000_000_000).padStart(12, '0')}`;
/** One confirmed reservation whose actual time is [start, end) and whose occupied time is widened by its buffers. */
function reservation(id: string, equipment: string, title: string, kind: 'booking' | 'maintenance', start: number, end: number,
	setupMinutes: number, cleanupMinutes: number, revision: number): Row {
	return {
		id, equipmentId: equipment, status: 'confirmed', title, kind,
		startsAt: iso(start), endsAt: iso(end), occupiedStartsAt: iso(start - setupMinutes * minute), occupiedEndsAt: iso(end + cleanupMinutes * minute),
		setupMinutes, cleanupMinutes, revision,
		projectId: '00000000-0000-4000-d000-000000000001', ownerId: '00000000-0000-4000-d000-000000000002', createdBy: 'Synthetic person', notes: 'Synthetic note must not enter state'
	};
}
/** Occupancy for one equipment and window, echoing the request. Every row is placed relative to the window's own length,
 *  so a short first or last chunk is still a valid answer (A's review S6). Variants:
 *  - `equipment-ok`: complete, with a booking across the window's end and one across its start (each identical from the
 *    neighbouring window, so deduplication is exercised), an overnight booking, and a maintenance with buffers;
 *  - `equipment-empty` / `equipment-more`: complete with no rows;
 *  - `equipment-partial`: exactly 200 rows spaced over the window and `nextOffset: 200`;
 *  - `equipment-conflict-a` / `-b`: one fixed reservation ID at the same revision with different titles, so its second
 *    read (from another cell) contradicts the first;
 *  - `equipment-zone-perth`: a complete empty answer whose `timezone` differs from the organisation's (zone changed);
 *  - `equipment-malformed`: a row missing its fields. */
function occupancyBody(control: EquipmentControl, equipment: string, from: string, to: string): unknown {
	const low = Date.parse(from), high = Date.parse(to), length = high - low;
	const at = (fraction: number) => low + Math.floor(length * fraction / hour) * hour;
	const body = (coverage: 'complete' | 'partial', reservations: Row[], nextOffset: number | null = null) =>
		({ from, to, timezone: zoneFor(control), coverage, nextOffset, reservations, requestedBy: 'Synthetic person' });
	const boundary = (edge: number) => reservation(rowId(equipment, Math.floor(edge / hour)), equipment, 'Sample long conditioning', 'booking', edge - 6 * hour, edge + 6 * hour, 0, 0, 2);
	switch (control) {
		case 'equipment-malformed': return body('complete', [{ id: reservationId(999) }]);
		case 'equipment-empty': case 'equipment-more': case 'equipment-zone-perth': case 'equipment-zone-bogus': return body('complete', []);
		case 'equipment-partial': {
			const step = Math.max(minute, Math.floor(length / 200 / minute) * minute);
			return body('partial', Array.from({ length: 200 }, (_, i) =>
				reservation(rowId(equipment, 200 + i), equipment, `Sample slot ${i + 1}`, 'booking', low + i * step, low + i * step + Math.max(minute, step / 2), 0, 0, 1)), 200);
		}
		case 'equipment-conflict-a': return body('complete', [reservation(reservationId(900), equipment, 'Sample booking Alpha', 'booking', at(0.4), at(0.4) + 3 * hour, 0, 0, 1)]);
		case 'equipment-conflict-b': return body('complete', [reservation(reservationId(900), equipment, 'Sample booking Beta', 'booking', at(0.4), at(0.4) + 3 * hour, 0, 0, 1)]);
		default: return body('complete', [
			boundary(low), boundary(high),
			reservation(rowId(equipment, 1), equipment, 'Sample overnight brew', 'booking', at(0.3), Math.min(at(0.3) + 10 * hour, high - hour), 0, 0, 1),
			reservation(rowId(equipment, 3), equipment, 'Sample clean in place', 'maintenance', at(0.6), Math.min(at(0.6) + 2 * hour, high - hour), 30, 60, 1)
		]);
	}
}

/** The raw body for `control` answering the read of `path`, or null when `path` is not a schedule read. */
export function equipmentFixture(control: EquipmentControl, path: string): unknown | null {
	const org = organisationPathPattern.exec(path);
	if (org) return organisationBody(control, org[1]!);
	const page = equipmentPagePathPattern.exec(path);
	if (page) return equipmentPageBody(control, Number(page[1]));
	const occupancy = occupancyPathPattern.exec(path);
	if (occupancy) return occupancyBody(control, occupancy[1]!, occupancy[2]!, occupancy[3]!);
	return null;
}
