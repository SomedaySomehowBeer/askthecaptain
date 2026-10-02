/** The rules of selective reversal (versions contract §4, amendment §3–§4; D29), as pure functions over the journal's
 *  changes. Code, never a model, decides what a change's state is, what must go with it and what reversing it writes.
 *
 *  Vocabulary:
 *  - A *change* is one `record_changes` row: one field of a record or of an item (a step), or one item's create, remove,
 *    attach or detach.
 *  - A change's *slot* is what it changed: a record field, an item's existence, or an item's field. A later change of
 *    the same slot (for an item's existence: anything later on that item) is a conflict, even when the value has since
 *    returned (amendment §2: provenance, not equal values).
 *  - An *entry* is what a person sees and ticks: one change, or a coupled group of changes written together in one
 *    change set (a booking's time, a task's status with its completion, a stock count with when and by whom). */

export type RecordKind = 'task' | 'reservation' | 'stock_item' | 'series' | 'equipment' | 'tag' | 'thread';
export const recordKinds: readonly RecordKind[] = ['task', 'reservation', 'stock_item', 'series', 'equipment', 'tag', 'thread'];
export type Operation = 'create' | 'update' | 'remove' | 'attach' | 'detach';
export type ItemKind = 'step' | 'evidence' | 'tag';

/** One journalled change. `before`/`after` are the stored JSON exactly (column names as written, snake case);
 *  `shownBefore`/`shownAfter` are the same values with object keys in the API's camelCase. */
export type Change = { id: string; changeSetId: string; recordKind: RecordKind; recordId: string; operation: Operation; field: string | null;
	itemKind: ItemKind | null; itemId: string | null; before: unknown; after: unknown; shownBefore: unknown; shownAfter: unknown;
	reversesChangeId: string | null; createdAt: Date };

/** Coupled fields, fixed in code (contract §4): they reverse together or not at all, and show as one entry. */
export const coupled: Partial<Record<RecordKind, Record<string, string>>> = {
	task: { status: 'status', completed_by: 'status', completed_at: 'status' },
	reservation: { equipment_id: 'time', starts_at: 'time', ends_at: 'time', setup_minutes: 'time', cleanup_minutes: 'time' },
	stock_item: { current_count: 'count', counted_at: 'count', counted_by: 'count' },
};

/** Why an entry can never be reversed (the client words each one). Reserved codes are named so a client handles them
 *  before the increment that writes them: `provider_owned` (a quantity a connected provider owns, D15) and
 *  `external_effect` (R9). */
export const irreversibleReasons = ['record_created', 'record_removed', 'record_gone', 'item_gone', 'tag_gone', 'became_task', 'provider_owned', 'external_effect'] as const;
export type IrreversibleReason = typeof irreversibleReasons[number];

/** Why a reversal that history allows cannot apply against the records as they are now (preview only). */
export type BlockedReason = 'slot_taken' | 'invalid_time' | 'equipment_archived' | 'reservation_cancelled' | 'evidence_required' | 'step_has_evidence'
	| 'evidence_kind_retired' | 'owner_inactive' | 'task_unavailable' | 'tag_archived' | 'stock_archived' | 'stock_unit_counted' | 'supplier_unavailable'
	| 'name_taken' | 'tag_dates_invalid' | 'recurrence_invalid' | 'equipment_in_use' | 'already_current';

export const camel = (name: string) => name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

export const groupOf = (change: Pick<Change, 'recordKind' | 'operation' | 'field' | 'itemKind'>): string | null =>
	change.operation === 'update' && change.field && (change.itemKind === null || change.itemKind === 'step') ? coupled[change.recordKind]?.[change.field] ?? null : null;

const item = (change: Pick<Change, 'itemKind' | 'itemId'>) => change.itemKind ? `${change.itemKind}:${change.itemId}` : null;
const sameRecord = (a: Change, b: Change) => a.recordKind === b.recordKind && a.recordId === b.recordId;

/** The slot a change writes: `f:<field>` (record field), `i:<item>` (an item's existence), `i:<item>:f:<field>`, or
 *  `record` (the record's own creation or removal). */
export function slotOf(change: Change): string {
	const i = item(change);
	if (!i) return change.operation === 'update' ? `f:${change.field}` : 'record';
	return change.operation === 'update' ? `i:${i}:f:${change.field}` : `i:${i}`;
}

/** Whether `later` is a later change of what `change` changed. Server ids are uuidv7, so their text order is the
 *  journal's order (each record's writers are serialised by its row lock). */
export function isLater(change: Change, later: Change): boolean {
	if (later.id <= change.id || !sameRecord(change, later)) return false;
	if (!change.itemKind) return change.operation === 'update' && !later.itemKind && later.operation === 'update' && later.field === change.field;
	if (item(later) !== item(change)) return false;
	if (change.operation !== 'update') return true; // an item's existence: anything later on that item
	return later.operation !== 'update' || later.field === change.field;
}

/** Whether reversal change `reversal` undid `change`. A reversal names the earliest change it reversed in its slot;
 *  every change of that slot from there up to the reversal had to be selected with it (else it was a conflict), so all
 *  of them are reversed by it. For an item's existence that is everything on the item in between. */
export function covers(reversal: Change, change: Change): boolean {
	if (!reversal.reversesChangeId || change.id < reversal.reversesChangeId || change.id >= reversal.id || !sameRecord(reversal, change)) return false;
	if (item(reversal) !== item(change)) return false;
	if (reversal.operation === 'update') return change.operation === 'update' && change.field === reversal.field;
	return reversal.itemKind !== null;
}

/** The journal of one or more records, with the derived relations the rules need. */
export class Journal {
	readonly changes: Change[];
	readonly #byId: Map<string, Change>;
	readonly #reversedBy = new Map<string, Change | null>();
	constructor(changes: Change[]) {
		this.changes = [...changes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		this.#byId = new Map(this.changes.map(change => [change.id, change]));
	}
	get(id: string) { return this.#byId.get(id); }
	/** The first reversal that undid this change, or null. */
	reversedBy(change: Change): Change | null {
		if (!this.#reversedBy.has(change.id)) {
			this.#reversedBy.set(change.id, this.changes.find(other => other.id > change.id && covers(other, change)) ?? null);
		}
		return this.#reversedBy.get(change.id)!;
	}
	/** The later changes of what `members` changed, outside `members`. */
	later(members: Change[]): Change[] {
		const ids = new Set(members.map(member => member.id));
		return this.changes.filter(other => !ids.has(other.id) && members.some(member => isLater(member, other)));
	}
	/** The later changes still in effect (not themselves reversed): the ones a person would have to add. */
	liveLater(members: Change[]): Change[] { return this.later(members).filter(other => !this.reversedBy(other)); }
}

export type Entry = { key: string; group: string | null; members: Change[] };

/** Groups changes into entries: per change set, record and item, one entry per coupled group, else one per change. */
export function entriesOf(changes: Change[]): Entry[] {
	const entries = new Map<string, Entry>();
	for (const change of [...changes].sort((a, b) => (a.id < b.id ? -1 : 1))) {
		const group = groupOf(change);
		const key = [change.changeSetId, change.recordKind, change.recordId, item(change) ?? '', group ?? change.id].join('|');
		const entry = entries.get(key) ?? { key, group, members: [] };
		entry.members.push(change);
		entries.set(key, entry);
	}
	return [...entries.values()];
}

/** The entry's field as the API names it: the group's name, the field in camelCase, or null for an item's existence. */
export const entryField = (entry: Entry) => entry.group ?? (entry.members[0]!.field ? camel(entry.members[0]!.field) : null);
export const entryFields = (entry: Entry) => entry.members.filter(member => member.field).map(member => camel(member.field!));
/** A group shows as one value: `{ field: value }` of its members; a single change shows its own value. */
export function shown(entry: Entry, side: 'shownBefore' | 'shownAfter'): unknown {
	if (!entry.group) return entry.members[0]![side];
	return Object.fromEntries(entry.members.map(member => [camel(member.field!), member[side]]));
}
