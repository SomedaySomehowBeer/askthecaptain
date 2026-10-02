/** History and preview copy, worded by code (versions contract §4–§6; design boards 5–11). Pure: no React, no network.
 *  A change reads exactly as its change line does (`wordChanges` from ../wording.ts); this module adds the states, the
 *  reasons in plain words, the preview's names and values, and when history starts. Every reason code in the contract
 *  has its own sentence; any other code gets an honest generic one. */
import type { LineChange } from '../contracts.ts';
import { firstNameOf, rowField, wordChanges, wordDate, wordInstant, wordMinutes, type Names as LineNames, type Segment } from '../wording.ts';
import type { ChangeSet, Entry, HistoryActor, HistoryStart, Names, PreviewEntry, SlotTaken } from './contracts.ts';

export type HistoryWords = {
	/** Names the screen loaded beside the page's own (step titles, equipment, members). */
	readonly names?: LineNames;
	readonly zone?: string;
	/** The wall-clock now, for "today". */
	readonly now: number;
	/** A stock item's unit. */
	readonly unit?: string | null;
	/** A booking's equipment, for a slot taken on it. */
	readonly equipmentName?: string | null;
};

/** The line changes an entry stands for: a coupled group's fields one by one, or the change itself. */
export function entryChanges(entry: Entry): LineChange[] {
	const base = { recordKind: entry.recordKind, recordId: entry.recordId, itemKind: entry.itemKind, itemId: entry.itemId };
	if (entry.operation === 'update' && entry.field && coupled[entry.recordKind] === entry.field && isObject(entry.before) && isObject(entry.after)) {
		const before = entry.before, after = entry.after;
		return entry.fields.map((field, i) => ({ ...base, id: entry.changeIds[i] ?? entry.id, operation: 'update' as const, field, before: before[field] ?? null, after: after[field] ?? null }));
	}
	return [{ ...base, id: entry.id, operation: entry.operation, field: entry.field, before: entry.before, after: entry.after }];
}
const coupled: Partial<Record<string, string>> = { task: 'status', reservation: 'time', stock_item: 'count' };
const isObject = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);

/** Names for wording from the page's `names` first, then what the screen loaded. Never a guess. */
export function lineNames(names: Names, loaded: LineNames = {}): LineNames {
	return {
		person: (id) => names.people[id] ?? loaded.person?.(id),
		tag: (id) => names.tags[id] ?? loaded.tag?.(id),
		step: (id) => loaded.step?.(id),
		equipment: (id) => loaded.equipment?.(id),
		task: (id) => loaded.task?.(id)
	};
}

const capital = (segments: Segment[]): Segment[] => segments.length ? [{ ...segments[0]!, text: segments[0]!.text.charAt(0).toUpperCase() + segments[0]!.text.slice(1) }, ...segments.slice(1)] : segments;
/** "Changed the due date from Tue 6 Oct to Thu 8 Oct", as the change line says it, as a sentence. */
export function entrySentence(entry: Entry, set: Pick<ChangeSet, 'causeKind'>, names: Names, words: HistoryWords): Segment[] {
	const year = new Date(words.now).getFullYear();
	return capital(wordChanges(entryChanges(entry), { names: lineNames(names, words.names), zone: words.zone, year, unit: words.unit, reversal: set.causeKind === 'reversal' }));
}
export const plainText = (segments: readonly Segment[]) => segments.map((s) => s.text).join('');

/** Who acted, in full: "Tom Reilly"; the system as "Captain"; a workflow as its person's. */
export function actorName(actor: HistoryActor): string {
	if (actor.kind === 'system') return 'Captain';
	if (actor.kind === 'workflow') return actor.name ? `${firstNameOf(actor.name)}’s workflow` : 'A workflow';
	return actor.name ?? 'A former member';
}
export function actorInitials(actor: HistoryActor): string {
	if (actor.kind === 'system') return 'C';
	const parts = (actor.name ?? '').trim().split(/\s+/).filter(Boolean);
	return parts.length ? parts.slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') : '?';
}

const dayOf = (iso: string, words: HistoryWords) => wordInstant(iso, words.zone, new Date(words.now).getFullYear());
const isToday = (iso: string, words: HistoryWords) => { const a = dayOf(iso, words), b = dayOf(new Date(words.now).toISOString(), words); return Boolean(a && b && a.day === b.day); };
/** A change set's time: "Today, 9:12 am" or "Thu 1 Oct, 4:40 pm". */
export function setTime(iso: string, words: HistoryWords): string {
	const at = dayOf(iso, words);
	if (!at) return iso;
	return `${isToday(iso, words) ? 'Today' : at.day}, ${at.time}`;
}
/** A day inside a sentence: "today" or "on Thu 1 Oct". */
export function onDay(iso: string, words: HistoryWords): string {
	const at = dayOf(iso, words);
	if (!at) return '';
	return isToday(iso, words) ? 'today' : `on ${at.day}`;
}
/** A day as a button names it: "today" or "Thu 1 Oct". */
const dayName = (iso: string, words: HistoryWords) => isToday(iso, words) ? 'today' : dayOf(iso, words)?.day ?? '';

export const recordNoun: Record<string, string> = { task: 'task', reservation: 'booking', stock_item: 'item', series: 'recurring task', equipment: 'equipment', tag: 'tag', thread: 'thread' };

// ---- what an entry is called -----------------------------------------------------------------------------------

const fieldLabels: Record<string, string> = {
	title: 'Title', body: 'Description', status: 'Status', ownerId: 'Owner', due: 'Due date', evidenceRequired: 'Evidence required', seriesId: 'Recurring work',
	periodStart: 'Period start', periodEnd: 'Period end', recurrence: 'Repeat', everyMonths: 'Interval', anchor: 'Start date', dueOffsetDays: 'Due offset', pausedAt: 'Paused',
	kind: 'Kind', reference: 'Link', label: 'Label', name: 'Name', archivedAt: 'Archived', equipmentId: 'Equipment', time: 'Time', taskId: 'Linked task', location: 'Location',
	unitLabel: 'Unit', count: 'Count', currentCount: 'Count', reorderPoint: 'Reorder point', preferredSupplierId: 'Preferred supplier', notes: 'Notes', startsOn: 'Start', endsOn: 'End'
};
const humanField = (field: string) => fieldLabels[field] ?? capitalWord(field.replace(/([A-Z])/g, ' $1').toLowerCase());
const capitalWord = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** The field as it sits in a sentence: "the due date", "the time". */
export const fieldNoun = (field: string | null) => field ? humanField(field).toLowerCase() : 'value';

/** The preview's name for an entry: "Due date", "Tag Production", "Step Order pallet wrap", "Time". */
export function entryName(entry: Entry, names: Names, words: HistoryWords): string {
	if (entry.itemKind === 'tag') { const n = (entry.itemId && (names.tags[entry.itemId] ?? words.names?.tag?.(entry.itemId))) || null; return n ? `Tag ${n}` : 'A tag'; }
	if (entry.itemKind === 'step') {
		const title = text(rowField(entry.after, 'title')) ?? text(rowField(entry.before, 'title')) ?? (entry.itemId ? words.names?.step?.(entry.itemId) ?? null : null);
		const step = title ? `Step ${title}` : 'A step';
		return entry.field && entry.field !== 'status' && entry.operation === 'update' ? `${step}: ${humanField(entry.field).toLowerCase()}` : step;
	}
	if (entry.itemKind === 'evidence') { const label = text(rowField(entry.after ?? entry.before, 'label')) ?? text(rowField(entry.after ?? entry.before, 'reference')); return label ? `Evidence ${label}` : 'Evidence'; }
	if (!entry.field) return capitalWord(recordNoun[entry.recordKind] ?? 'record');
	return humanField(entry.field);
}
const text = (v: unknown): string | null => typeof v === 'string' && v.trim() ? v.trim() : null;

/** What a coupled group means when it is undone (boards 9 and 7). */
export function together(entry: Entry): string | null {
	if (entry.recordKind === 'reservation' && entry.field === 'time') return 'Start, end, setup and cleanup are undone together.';
	if (entry.field === 'status' && entry.fields.length > 1) return 'The status and its completion are undone together.';
	if (entry.recordKind === 'stock_item' && entry.field === 'count') return 'The count, and who counted it and when, are undone together.';
	return null;
}

// ---- values -----------------------------------------------------------------------------------------------------

const statusWords: Record<string, string> = { suggested: 'Suggested', open: 'Open', in_progress: 'In progress', done: 'Done', cancelled: 'Cancelled', confirmed: 'Confirmed' };
const clip = (value: string, max = 80) => { const chars = [...value.trim().replace(/\s+/g, ' ')]; return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : chars.join(''); };

/** A booking's time as the preview says it: "Fri 9 Oct, 1:00 pm to 5:00 pm". */
export function timeRange(start: unknown, end: unknown, words: HistoryWords): string | null {
	if (typeof start !== 'string' || typeof end !== 'string') return null;
	const year = new Date(words.now).getFullYear(), a = wordInstant(start, words.zone, year), b = wordInstant(end, words.zone, year);
	if (!a || !b) return null;
	return a.day === b.day ? `${a.day}, ${a.time} to ${b.time}` : `${a.day}, ${a.time} to ${b.day}, ${b.time}`;
}

/** One side of a field's value in words. */
function fieldValue(field: string, value: unknown, entry: Entry, names: Names, words: HistoryWords): string {
	const year = new Date(words.now).getFullYear();
	if (value === null || value === undefined || value === '') {
		if (field === 'ownerId') return 'No owner';
		if (field === 'due') return 'No due date';
		return 'None';
	}
	switch (field) {
		case 'ownerId': case 'completedBy': case 'countedBy': return typeof value === 'string' ? names.people[value] ?? words.names?.person?.(value) ?? 'Another member' : 'Another member';
		case 'due': case 'periodStart': case 'periodEnd': case 'anchor': case 'startsOn': case 'endsOn': return typeof value === 'string' ? wordDate(value, year) : String(value);
		case 'status': return typeof value === 'string' ? statusWords[value] ?? value : String(value);
		case 'equipmentId': return typeof value === 'string' ? words.names?.equipment?.(value) ?? 'Other equipment' : 'Other equipment';
		case 'setupMinutes': case 'cleanupMinutes': return wordMinutes(value);
		case 'currentCount': case 'reorderPoint': return `${String(value)}${words.unit ? ` ${words.unit}` : ''}`;
		case 'evidenceRequired': return value === true ? 'Required' : 'Not required';
		case 'archivedAt': case 'pausedAt': return 'Yes';
		case 'countedAt': case 'completedAt': case 'startsAt': case 'endsAt': { const at = typeof value === 'string' ? wordInstant(value, words.zone, year) : null; return at ? `${at.day}, ${at.time}` : String(value); }
		case 'body': case 'notes': return typeof value === 'string' ? clip(value, 60) : 'Changed';
		case 'taskId': return typeof value === 'string' ? words.names?.task?.(value) ?? 'A task' : 'A task';
		case 'preferredSupplierId': return 'A supplier';
	}
	void entry;
	return typeof value === 'string' ? clip(value) : typeof value === 'number' ? String(value) : typeof value === 'boolean' ? (value ? 'Yes' : 'No') : 'Changed';
}

/** A preview value (`now` or `proposed`) in words; null `proposed` while nothing is decided is "Not decided". */
export function valueWords(entry: PreviewEntry, side: 'now' | 'proposed', names: Names, words: HistoryWords): string {
	const value = entry[side];
	if (side === 'proposed' && value === null && entry.state !== 'reversible' && entry.state !== 'blocked') return 'Not decided';
	const noun = recordNoun[entry.recordKind] ?? 'record';
	const on = entry.recordKind === 'thread' ? 'this thread' : `this ${noun}`;
	if (entry.itemKind) {
		// An item's existence: its row, or nothing.
		if (entry.operation !== 'update') {
			const present = value !== null;
			if (side === 'now') return entry.itemKind === 'tag' ? (present ? `On ${on}` : `Not on ${on}`) : (present ? `On the ${noun}` : `Not on the ${noun}`);
			const was = entry.now !== null;
			if (present === was) return present ? 'Stays' : 'Stays removed';
			return present ? (entry.itemKind === 'tag' ? 'Added back' : 'Restored') : 'Removed';
		}
		if (value === null) return 'Gone';
	}
	if (entry.field === 'time' && value && typeof value === 'object') {
		const v = value as Record<string, unknown>, parts: string[] = [];
		const range = timeRange(v.startsAt, v.endsAt, words);
		if (range) parts.push(range);
		else for (const f of ['startsAt', 'endsAt'] as const) if (f in v) parts.push(`${f === 'startsAt' ? 'starts' : 'ends'} ${fieldValue(f, v[f], entry, names, words)}`);
		if ('equipmentId' in v) parts.push(fieldValue('equipmentId', v.equipmentId, entry, names, words));
		if ('setupMinutes' in v) parts.push(`setup ${wordMinutes(v.setupMinutes)}`);
		if ('cleanupMinutes' in v) parts.push(`cleanup ${wordMinutes(v.cleanupMinutes)}`);
		return capitalWord(parts.join(', ')) || 'Changed';
	}
	if (entry.field === 'count' && value && typeof value === 'object') {
		const v = value as Record<string, unknown>;
		if ('currentCount' in v) return v.currentCount === null ? 'Not counted' : fieldValue('currentCount', v.currentCount, entry, names, words);
		return 'countedAt' in v ? `Counted ${fieldValue('countedAt', v.countedAt, entry, names, words)}` : 'Changed';
	}
	if (entry.field === 'status' && value && typeof value === 'object') return fieldValue('status', (value as Record<string, unknown>).status, entry, names, words);
	return entry.field ? fieldValue(entry.field, value, entry, names, words) : 'Changed';
}

// ---- states -----------------------------------------------------------------------------------------------------

const irreversibleWords: Record<string, (entry: Entry) => string> = {
	record_created: (e) => e.recordKind === 'reservation' ? 'Cancel the booking instead.' : e.recordKind === 'stock_item' ? 'Archive the item instead.'
		: e.recordKind === 'task' || e.recordKind === 'series' ? 'Cancel or complete it instead.' : 'Change it or remove it instead.',
	record_removed: () => 'It was removed, and a removal is not undone here.',
	record_gone: (e) => `This ${recordNoun[e.recordKind] ?? 'record'} no longer exists.`,
	item_gone: (e) => e.itemKind === 'evidence' ? 'That evidence, or the step it was on, no longer exists.' : e.itemKind === 'step' ? 'That step no longer exists.' : 'That item no longer exists.',
	tag_gone: () => 'That tag has since been deleted.',
	became_task: () => 'This thread became a task, so its tags are now the task’s. Undo them from the task’s history.',
	provider_owned: () => 'A connected service owns this quantity, so it is changed there, not here.',
	external_effect: () => 'This reached outside Captain, so it cannot be taken back here.'
};
/** Why an entry can never be undone, in plain words (contract §4). */
export function irreversibleReason(reason: string, entry: Entry): string {
	return irreversibleWords[reason]?.(entry) ?? 'Captain can’t undo this change. This app doesn’t know the reason Captain gave yet.';
}

/** History's note and badge for an entry (boards 5, 6, 11). */
export function stateWords(entry: Entry, words: HistoryWords): { badge: 'Changed since' | 'Undone' | 'Can’t undo' | null; note: string | null; tickable: boolean } {
	switch (entry.state) {
		case 'reversible': return { badge: null, note: null, tickable: true };
		case 'conflict': {
			const latest = entry.later.reduce((a, b) => (Date.parse(a.at) >= Date.parse(b.at) ? a : b));
			const what = entry.itemKind ? (entry.itemKind === 'tag' ? 'The tag' : entry.itemKind === 'step' ? 'The step' : 'The evidence') : `The ${fieldNoun(entry.field)}`;
			return { badge: 'Changed since', note: `${what} was changed again ${onDay(latest.at, words)}.`, tickable: true };
		}
		case 'reversed': return { badge: 'Undone', note: `Undone by ${actorName(entry.reversedBy.actor)} ${onDay(entry.reversedBy.at, words)}.`, tickable: false };
		case 'irreversible': return { badge: 'Can’t undo', note: irreversibleReason(entry.reason, entry), tickable: false };
		default: return { badge: null, note: null, tickable: false };
	}
}

/** Why a preview entry cannot apply against the records now, in plain words (contract §4 "Blocked"). */
export function blockedReason(entry: PreviewEntry & { state: 'blocked' }, names: Names, words: HistoryWords): string {
	const noun = recordNoun[entry.recordKind] ?? 'record';
	switch (entry.reason) {
		case 'slot_taken': {
			const d = entry.detail as SlotTaken | null;
			if (!d) return 'This can’t be undone now: that time is taken by another booking.';
			const year = new Date(words.now).getFullYear(), from = wordInstant(d.occupiedStartsAt, words.zone, year), to = wordInstant(d.occupiedEndsAt, words.zone, year);
			const span = !from || !to ? '' : from.day === to.day ? ` on ${from.day} from ${from.time} to ${to.time}` : ` from ${from.day}, ${from.time} to ${to.day}, ${to.time}`;
			return `This can’t be undone now. ${d.title}${d.ownerName ? ` (${d.ownerName})` : ''} holds ${words.equipmentName ? `the ${words.equipmentName}` : 'the equipment'}${span}.`;
		}
		case 'already_current': return `There is nothing to undo: the ${entry.itemKind ? (entry.itemKind === 'tag' ? 'tag' : entry.itemKind) : fieldNoun(entry.field)} is already ${entry.itemKind && entry.operation !== 'update' ? (entry.now === null ? 'gone' : 'there') : `${valueWords(entry, 'now', names, words)}`}.`;
		case 'invalid_time': return 'This can’t be undone now: the earlier time would end before it starts, or last more than a year.';
		case 'equipment_archived': return 'This can’t be undone now: the equipment is archived. Restore it first.';
		case 'reservation_cancelled': return 'This booking is cancelled. Its time changes only with the cancellation undone too.';
		case 'evidence_required': return 'This can’t be undone now: the task is done and needs at least one piece of evidence.';
		case 'step_has_evidence': return 'This can’t be undone now: the step has evidence attached. Remove its evidence first.';
		case 'evidence_kind_retired': return 'This evidence was an email, which Captain no longer keeps, so it can’t be restored.';
		case 'owner_inactive': return 'This can’t be undone now: the earlier owner is no longer an active member.';
		case 'task_unavailable': return 'This can’t be undone now: the task it was linked to is cancelled or gone.';
		case 'tag_archived': return 'This can’t be undone now: the tag is archived. Restore the tag first.';
		case 'stock_archived': return 'This can’t be undone now: the item is archived. Restore it first.';
		case 'stock_unit_counted': return 'The unit can’t change back once the item has a count.';
		case 'supplier_unavailable': return 'This can’t be undone now: the earlier supplier is archived or gone.';
		case 'name_taken': return `This can’t be undone now: another ${noun} already has that name.`;
		case 'tag_dates_invalid': return 'This can’t be undone now: the tag would end before it starts.';
		case 'recurrence_invalid': return 'This can’t be undone now: the earlier schedule is no longer a valid one.';
		case 'equipment_in_use': return 'This can’t be undone now: the equipment has bookings still to come.';
	}
	return 'This can’t be undone now. This app doesn’t know the reason Captain gave yet; nothing will change.';
}

/** The conflict explanation (board 8): what changed it again, by whom and when, and that Captain won't choose. */
export function conflictWords(entry: Entry & { state: 'conflict' }, names: Names, words: HistoryWords): { note: string; also: string } {
	const later = [...entry.later].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
	const what = entry.itemKind ? (entry.itemKind === 'tag' ? 'tag' : entry.itemKind) : fieldNoun(entry.field);
	const describe = (l: (typeof later)[number]) => {
		const who = firstNameOf(l.actor.name) ?? actorName(l.actor);
		if (entry.itemKind || l.field === null || entry.field === 'time' || entry.field === 'count' || entry.field === 'status') return `${who} changed it ${onDay(l.at, words)}`;
		const pseudo = { ...entry, field: l.field, fields: [l.field] } as Entry;
		const value = (v: unknown) => fieldValue(l.field!, v, pseudo, names, words);
		return `${who} moved it from ${value(l.before)} to ${value(l.after)} ${onDay(l.at, words)}`;
	};
	const note = `The ${what} was changed again after this: ${later.map(describe).join('; ')}. Captain won’t choose between them.`;
	const days = [...new Set(later.map((l) => dayName(l.at, words)))];
	const back = !entry.itemKind && entry.field && entry.field !== 'time' && entry.field !== 'count' && entry.field !== 'status' ? fieldValue(entry.field, entry.before, entry, names, words) : null;
	const also = `${later.length === 1 ? `Also undo the change of ${days[0]}` : `Also undo the ${later.length} later changes (${days.join(' and ')})`}.${back ? ` The ${what} goes back to ${back}.` : ''}`;
	return { note, also };
}

/** Board 10: a conflict that appeared since the preview, said as what moved. */
export function staleConflict(entry: Entry & { state: 'conflict' }, names: Names, words: HistoryWords): string {
	const l = [...entry.later].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0]!;
	const who = firstNameOf(l.actor.name) ?? actorName(l.actor);
	const at = dayOf(l.at, words);
	const when = isToday(l.at, words) ? `at ${at?.time ?? ''}` : onDay(l.at, words);
	const moved = !entry.itemKind && l.field && entry.field !== 'time' && entry.field !== 'count' && entry.field !== 'status'
		? `${who} moved it from ${fieldValue(l.field, l.before, entry, names, words)} to ${fieldValue(l.field, l.after, entry, names, words)} ${when}`
		: `${who} changed it ${when}`;
	return `${moved}. Leave it, or tick ${who}’s change in History as well.`;
}

/** Board 10's alert: nothing was undone, who moved what, and that the preview is fresh. */
export function staleAlert(fresh: readonly PreviewEntry[], names: Names, words: HistoryWords): string {
	const conflict = fresh.find((c): c is PreviewEntry & { state: 'conflict' } => c.state === 'conflict');
	if (conflict) {
		const l = [...conflict.later].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0]!;
		const who = firstNameOf(l.actor.name) ?? actorName(l.actor);
		const what = conflict.itemKind ? `the ${conflict.itemKind === 'tag' ? 'tag' : conflict.itemKind}` : `the ${fieldNoun(conflict.field)}`;
		const at = dayOf(l.at, words);
		return `${who} changed ${what} ${isToday(l.at, words) ? `at ${at?.time ?? ''}` : onDay(l.at, words)}, so this preview was out of date. Here it is again.`;
	}
	void names;
	return 'Something on this record changed since the preview, so it was out of date. Here it is again.';
}

/** The label of the stale sheet's button: what still applies (board 10). */
export function remainingLabel(remaining: readonly PreviewEntry[], all: number, names: Names, words: HistoryWords): string {
	if (remaining.length === all) return `Undo ${all} change${all === 1 ? '' : 's'}`;
	if (remaining.length === 1) {
		const e = remaining[0]!;
		const what = e.itemKind === 'tag' ? 'tag' : e.itemKind === 'step' ? 'step' : e.itemKind === 'evidence' ? 'evidence' : fieldNoun(e.field);
		void names; void words;
		return `Undo the ${what} only`;
	}
	return `Undo the ${remaining.length} that still apply`;
}

/** "Everything else stays as it is, including Tom's change of owner today." (board 7). */
export function untouched(others: readonly { entry: Entry; set: ChangeSet }[], words: HistoryWords): string {
	const newest = others[0];
	if (!newest) return 'Everything else stays as it is.';
	const who = firstNameOf(newest.set.actor.name) ?? actorName(newest.set.actor);
	const what = newest.entry.itemKind ? (newest.entry.itemKind === 'tag' ? 'tag' : newest.entry.itemKind) : fieldNoun(newest.entry.field);
	return `Everything else stays as it is, including ${who}’s change of ${what} ${onDay(newest.set.createdAt, words)}.`;
}

/** The last row: when history starts (board 5). */
export function startWords(start: HistoryStart, kind: string, words: HistoryWords): { text: string; link: string } {
	const at = wordInstant(start.at, words.zone);
	const day = at ? at.day : wordDate(start.at.slice(0, 10));
	const noun = recordNoun[kind] ?? 'record';
	const text = start.kind === 'baseline' ? `History starts on ${day}, when Captain began keeping it.`
		: start.kind === 'created' ? `History starts on ${day}, when this ${noun} was made.`
			: `History starts on ${day}, with the first change Captain kept.`;
	return { text, link: `See the ${noun} as it was then` };
}

const versionFields: Record<string, readonly string[]> = {
	task: ['title', 'status', 'ownerId', 'due', 'body'], reservation: ['title', 'status', 'startsAt', 'endsAt', 'setupMinutes', 'cleanupMinutes'],
	stock_item: ['name', 'location', 'currentCount', 'countedAt', 'reorderPoint'], series: ['title', 'ownerId', 'recurrence'], equipment: ['name'], tag: ['name', 'startsOn', 'endsOn'], thread: ['title']
};
/** A version's snapshot as a few read-only lines (the baseline row's "as it was then"). */
export function versionLines(snapshot: Record<string, unknown>, kind: string, names: Names, words: HistoryWords): { label: string; value: string }[] {
	const row = snapshot.row;
	const pseudo = { recordKind: kind, itemKind: null } as unknown as Entry;
	const lines = (versionFields[kind] ?? ['title']).flatMap((field) => {
		const value = rowField(row, field);
		if (value === undefined) return [];
		return [{ label: humanField(field), value: field === 'body' && !value ? 'None' : fieldValue(field, value, pseudo, names, words) }];
	});
	if (Array.isArray(snapshot.steps)) {
		const steps = snapshot.steps.flatMap((s) => { const t = text(rowField(s, 'title')); return t ? [`${rowField(s, 'status') === 'done' ? '✓ ' : ''}${clip(t, 60)}`] : []; });
		lines.push({ label: 'Steps', value: steps.length ? steps.join('\n') : 'None' });
	}
	if (Array.isArray(snapshot.tags)) {
		const tags = snapshot.tags.map((id) => typeof id === 'string' ? names.tags[id] ?? words.names?.tag?.(id) ?? 'A tag' : 'A tag');
		lines.push({ label: 'Tags', value: tags.length ? tags.join(', ') : 'None' });
	}
	return lines;
}
