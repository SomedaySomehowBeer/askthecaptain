/** Strict parsers for history, a version, the reversal preview, its apply and its `409 stale_preview` (versions contract
 *  §5 as built in V-C). An unknown key, a missing key, a wrong identity or an impossible combination throws, and the call
 *  is then treated as unavailable: the screen never shows a shape it does not understand. Reason codes are the exception
 *  that is open on purpose: an unknown code is kept and worded generically, so a later increment's code is honest copy,
 *  not a crash. */
import { isCanonicalInstant, isCanonicalUuid } from '../../api/paths.ts';
import { array, integer, keys, object, text, uuid } from '../parse.ts';
import type { ChangeOperation, JournalRecordKind } from '../contracts.ts';
import type { Applied, Basis, ChangeSet, Entry, EntryState, HistoryActor, HistoryPage, HistoryStart, Later, Names, Preview, PreviewEntry, Stale, Version } from './contracts.ts';

const bad = (): never => { throw new TypeError('history: unexpected response'); };
const nullable = <T>(x: unknown, parse: (x: unknown) => T): T | null => x === null ? null : parse(x);
const instant = (x: unknown): string => isCanonicalInstant(x) ? x : bad();
const bool = (x: unknown): boolean => typeof x === 'boolean' ? x : bad();
const oneOf = <T extends string>(x: unknown, choices: readonly T[]): T => typeof x === 'string' && (choices as readonly string[]).includes(x) ? x as T : bad();
const unique = (ids: string[]) => { if (new Set(ids).size !== ids.length) bad(); return ids; };
const isRow = (x: unknown) => x !== null && typeof x === 'object' && !Array.isArray(x);
/** A journalled value: JSON only, bounded. A task's body may be 16 000 characters, so a full row gets room for it. */
const json = (x: unknown, max = 40_000): unknown => { if (x === undefined || JSON.stringify(x).length > max) bad(); return x; };

export const journalKinds = ['task', 'reservation', 'stock_item', 'series', 'equipment', 'tag', 'thread'] as const satisfies readonly JournalRecordKind[];
const operations = ['create', 'update', 'remove', 'attach', 'detach'] as const satisfies readonly ChangeOperation[];
const groups: Record<string, readonly string[]> = {
	time: ['equipmentId', 'startsAt', 'endsAt', 'setupMinutes', 'cleanupMinutes'], status: ['status', 'completedBy', 'completedAt'], count: ['currentCount', 'countedAt', 'countedBy']
};
const coupledField: Partial<Record<JournalRecordKind, string>> = { task: 'status', reservation: 'time', stock_item: 'count' };
const fieldName = (x: unknown) => { const f = text(x, 60); return /^[a-z][A-Za-z]{0,59}$/.test(f) ? f : bad(); };
/** A reason code: the contract's, or a later one, worded generically by the client. */
const reason = (x: unknown) => { const r = text(x, 64); return /^[a-z][a-z_]{0,63}$/.test(r) ? r : bad(); };

export function parseActor(raw: unknown): HistoryActor {
	const x = object(raw); keys(x, ['kind', 'id', 'name']);
	const kind = oneOf(x.kind, ['person', 'workflow', 'system'] as const), id = nullable(x.id, uuid);
	if (kind === 'system' && id !== null) bad();
	return { kind, id, name: nullable(x.name, (v) => text(v, 500)) };
}
function parseLater(raw: unknown): Later {
	const x = object(raw); keys(x, ['id', 'changeSetId', 'actor', 'at', 'field', 'before', 'after']);
	return { id: uuid(x.id), changeSetId: uuid(x.changeSetId), actor: parseActor(x.actor), at: instant(x.at), field: nullable(x.field, fieldName), before: json(x.before), after: json(x.after) };
}
/** Slot taken: the blocking booking, its owner and its occupied times (contract §4). */
function parseSlotTaken(raw: unknown) {
	const x = object(raw); keys(x, ['reservationId', 'title', 'ownerId', 'ownerName', 'occupiedStartsAt', 'occupiedEndsAt']);
	const value = { reservationId: uuid(x.reservationId), title: text(x.title, 500), ownerId: nullable(x.ownerId, uuid), ownerName: nullable(x.ownerName, (v) => text(v, 500)),
		occupiedStartsAt: instant(x.occupiedStartsAt), occupiedEndsAt: instant(x.occupiedEndsAt) };
	if (Date.parse(value.occupiedEndsAt) <= Date.parse(value.occupiedStartsAt)) bad();
	return value;
}

const entryKeys = ['id', 'changeIds', 'recordKind', 'recordId', 'operation', 'field', 'fields', 'itemKind', 'itemId', 'before', 'after', 'reverses', 'state'];
const stateKeys: Record<string, string[]> = { reversible: [], conflict: ['later'], needs: ['needs'], irreversible: ['reason'], reversed: ['reversedBy'], blocked: ['reason'] };

/** One entry, history's or (with `preview`) the preview's. `allowed` are the states that may appear where it is read. */
function parseEntryIn(raw: unknown, preview: boolean): Entry & { now?: unknown; proposed?: unknown } {
	const x = object(raw);
	const state = oneOf(x.state, preview ? ['reversible', 'conflict', 'needs', 'irreversible', 'reversed', 'blocked'] as const : ['reversible', 'conflict', 'irreversible', 'reversed'] as const);
	keys(x, [...entryKeys, ...stateKeys[state]!, ...(preview ? ['now', 'proposed'] : [])], state === 'blocked' ? ['detail'] : []);
	const id = uuid(x.id), changeIds = unique(array(x.changeIds, uuid, 10)), operation = oneOf(x.operation, operations);
	const field = nullable(x.field, fieldName), fields = unique(array(x.fields, fieldName, 10)), itemKind = nullable(x.itemKind, (v) => oneOf(v, ['step', 'evidence', 'tag'] as const));
	const itemId = nullable(x.itemId, uuid), before = json(x.before), after = json(x.after);
	if (changeIds[0] !== id || (itemKind === null) !== (itemId === null) || (operation === 'update') !== (field !== null)) bad();
	if ((operation === 'attach' || operation === 'detach') !== (itemKind === 'tag')) bad();
	if ((operation === 'create' || operation === 'attach') && (before !== null || !isRow(after))) bad();
	if ((operation === 'remove' || operation === 'detach') && (after !== null || !isRow(before))) bad();
	const recordKind = oneOf(x.recordKind, journalKinds);
	// Coupled fields are fixed per record kind (a task's or step's status, a booking's time, a stock count): such an entry is
	// a group even with one member, and its values are objects of its fields.
	const group = operation === 'update' && field !== null && coupledField[recordKind] === field && (itemKind === null || itemKind === 'step') ? field : null;
	if (group) {
		if (!fields.length || fields.some((f) => !groups[group]!.includes(f))) bad();
		// A coupled group: one id per field, and values that are objects of exactly those fields.
		if (fields.length !== changeIds.length) bad();
		for (const side of [before, after]) { if (!isRow(side)) bad(); const k = Object.keys(side as object).sort(); if (k.join(',') !== [...fields].sort().join(',')) bad(); }
	} else {
		if (changeIds.length !== 1) bad();
		if (operation === 'update' ? fields.length !== 1 || fields[0] !== field : fields.length !== 0) bad();
		if (operation === 'update' && before === null && after === null) bad();
	}
	const reverses = unique(array(x.reverses, uuid, 10));
	let s: EntryState;
	switch (state) {
		case 'conflict': { const later = array(x.later, parseLater, 200); if (!later.length) bad(); s = { state, later }; break; }
		case 'needs': { const needs = unique(array(x.needs, uuid, 10)); if (!needs.length || needs.some((n) => changeIds.includes(n) === false)) bad(); s = { state, needs }; break; }
		case 'irreversible': s = { state, reason: reason(x.reason) }; break;
		case 'reversed': { const r = object(x.reversedBy); keys(r, ['changeId', 'changeSetId', 'actor', 'at']);
			s = { state, reversedBy: { changeId: uuid(r.changeId), changeSetId: uuid(r.changeSetId), actor: parseActor(r.actor), at: instant(r.at) } }; break; }
		case 'blocked': { const why = reason(x.reason);
			const detail = x.detail === undefined ? null : why === 'slot_taken' ? parseSlotTaken(x.detail) : object(json(x.detail, 4000));
			if (why === 'slot_taken' && detail === null) bad();
			s = { state, reason: why, detail }; break; }
		default: s = { state: 'reversible' };
	}
	const entry = { id, changeIds, recordKind, recordId: uuid(x.recordId), operation, field, fields, itemKind, itemId, before, after, reverses, ...s } as Entry;
	if (!preview) return entry;
	const now = json(x.now), proposed = json(x.proposed);
	// Nothing is proposed while nothing is decided.
	if (['conflict', 'needs', 'irreversible', 'reversed'].includes(state) && proposed !== null) bad();
	return { ...entry, now, proposed };
}
export const parseEntry = (raw: unknown): Entry => parseEntryIn(raw, false);
export const parsePreviewEntry = (raw: unknown): PreviewEntry => parseEntryIn(raw, true) as PreviewEntry;

export function parseChangeSet(raw: unknown): ChangeSet {
	const x = object(raw); keys(x, ['id', 'actor', 'causeKind', 'reversesChangeSetId', 'createdAt', 'changes']);
	const causeKind = oneOf(x.causeKind, ['request', 'workflow_run', 'routine', 'reversal', 'baseline'] as const);
	const reversesChangeSetId = nullable(x.reversesChangeSetId, uuid);
	if ((causeKind === 'reversal') !== (reversesChangeSetId !== null)) bad();
	const changes = array(x.changes, parseEntry, 500);
	if (new Set(changes.flatMap((c) => c.changeIds)).size !== changes.reduce((n, c) => n + c.changeIds.length, 0)) bad();
	// A reversal's changes each name what they reversed; an ordinary change set's name nothing.
	if (changes.some((c) => (c.reverses.length > 0) !== (causeKind === 'reversal'))) bad();
	return { id: uuid(x.id), actor: parseActor(x.actor), causeKind, reversesChangeSetId, createdAt: instant(x.createdAt), changes };
}

function parseNames(raw: unknown): Names {
	const x = object(raw); keys(x, ['people', 'tags']);
	const map = (v: unknown) => { const m = object(v); if (Object.keys(m).length > 500) bad();
		return Object.fromEntries(Object.entries(m).map(([k, name]) => [isCanonicalUuid(k) ? k : bad(), nullable(name, (n) => text(n, 500))])); };
	return { people: map(x.people), tags: map(x.tags) };
}
function parseStart(raw: unknown): HistoryStart {
	const x = object(raw); keys(x, ['kind', 'changeSetId', 'at', 'revision']);
	return { kind: oneOf(x.kind, ['baseline', 'created', 'first_change'] as const), changeSetId: uuid(x.changeSetId), at: instant(x.at), revision: integer(x.revision, 1) };
}

/** `GET …/history/:kind/:id`: one page, newest first, for exactly the record asked about. */
export function parseHistory(raw: unknown, expected: { kind: JournalRecordKind; id: string }): HistoryPage {
	const x = object(raw); keys(x, ['record', 'changeSets', 'nextCursor', 'start', 'names']);
	const r = object(x.record); keys(r, ['kind', 'id', 'revision', 'exists']);
	const record = { kind: oneOf(r.kind, journalKinds), id: uuid(r.id), revision: nullable(r.revision, (v) => integer(v, 1)), exists: bool(r.exists) };
	if (record.kind !== expected.kind || record.id !== expected.id) bad();
	const changeSets = array(x.changeSets, parseChangeSet, 50);
	if (new Set(changeSets.map((c) => c.id)).size !== changeSets.length) bad();
	changeSets.forEach((set, i) => {
		if (i > 0 && Date.parse(set.createdAt) > Date.parse(changeSets[i - 1]!.createdAt)) bad();
		if (!set.changes.length || set.changes.some((c) => c.recordKind !== record.kind || c.recordId !== record.id)) bad();
	});
	const nextCursor = nullable(x.nextCursor, (v) => { const s = text(v, 300); return s.length ? s : bad(); }), start = nullable(x.start, parseStart);
	if (nextCursor !== null && start !== null) bad();
	return { record, changeSets, nextCursor, start, names: parseNames(x.names) };
}

/** `GET …/history/:kind/:id/versions/:revision`. */
export function parseVersion(raw: unknown, expected: { kind: JournalRecordKind; id: string; revision: number }): Version {
	const x = object(raw); keys(x, ['recordKind', 'recordId', 'revision', 'changeSetId', 'createdAt', 'removed', 'snapshot']);
	const v = { recordKind: oneOf(x.recordKind, journalKinds), recordId: uuid(x.recordId), revision: integer(x.revision, 1), changeSetId: uuid(x.changeSetId), createdAt: instant(x.createdAt),
		removed: bool(x.removed), snapshot: object(json(x.snapshot, 400_000)) };
	if (v.recordKind !== expected.kind || v.recordId !== expected.id || v.revision !== expected.revision) bad();
	if (!isRow(v.snapshot.row)) bad();
	return v;
}

function parseBasis(raw: unknown): Basis {
	const x = object(raw); keys(x, ['recordKind', 'recordId', 'revision']);
	return { recordKind: oneOf(x.recordKind, journalKinds), recordId: uuid(x.recordId), revision: nullable(x.revision, (v) => integer(v, 1)) };
}
/** `POST …/reversals/preview`: one entry per selected entry, the basis it was computed on, and whether it applies. */
export function parsePreview(raw: unknown, selected?: readonly string[]): Preview {
	const x = object(raw); keys(x, ['changes', 'basis', 'applicable', 'names']);
	const changes = array(x.changes, parsePreviewEntry, 50), basis = array(x.basis, parseBasis, 50), applicable = bool(x.applicable);
	if (!changes.length || applicable !== changes.every((c) => c.state === 'reversible')) bad();
	const ids = changes.flatMap((c) => c.changeIds);
	if (new Set(ids).size !== ids.length) bad();
	// Every selected change is in exactly one entry; an entry may name companions not selected (state `needs`).
	if (selected && selected.some((id) => !ids.includes(id))) bad();
	if (new Set(basis.map((b) => `${b.recordKind}:${b.recordId}`)).size !== basis.length) bad();
	if (changes.some((c) => !basis.some((b) => b.recordKind === c.recordKind && b.recordId === c.recordId))) bad();
	return { changes, basis, applicable, names: parseNames(x.names) };
}
/** `201` from `POST …/reversals`: the new change set (the id sent, cause `reversal`) and the selected ids. */
export function parseApplied(raw: unknown, expected: { id: string; changeIds: readonly string[] }): Applied {
	const x = object(raw); keys(x, ['changeSet', 'reversed']);
	const changeSet = parseChangeSet(x.changeSet), reversed = unique(array(x.reversed, uuid, 50));
	if (changeSet.id !== expected.id || changeSet.causeKind !== 'reversal' || !changeSet.changes.length) bad();
	if ([...reversed].sort().join(',') !== [...new Set(expected.changeIds)].sort().join(',')) bad();
	return { changeSet, reversed };
}
/** The rest of a `409 stale_preview` body: the fresh preview and what moved. */
export function parseStale(raw: unknown, selected?: readonly string[]): Stale {
	const x = object(raw); keys(x, ['preview', 'moved']);
	return { preview: parsePreview(x.preview, selected), moved: array(x.moved, parseBasis, 50) };
}
