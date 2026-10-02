import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ApiClient, ApiOutcome } from '../../auth/contracts.ts';
import { apiOutcome } from '../../api/failure.ts';
import { createThreadCalls } from '../api.ts';
import type { WebStorage } from '../storage.ts';
import { historyRoute } from './route.ts';
import { makeTaskBody, parseMadeTask } from '../cards/make-task.ts';
import { wordChangeLine, wordDate } from '../wording.ts';
import type { Entry, PreviewEntry } from './contracts.ts';
import { createHistory, entryIndex, isTickable, targetOf } from './controller.ts';
import { parseApplied, parseChangeSet, parseHistory, parsePreview, parseStale, parseVersion } from './parse.ts';
import { createPendingUndoStorage } from './storage.ts';
import { blockedReason, conflictWords, entryChanges, entrySentence, irreversibleReason, plainText, remainingLabel, setTime, staleAlert, startWords, stateWords, untouched, valueWords, versionLines, type HistoryWords } from './words.ts';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const user = u(41), org = u(2), thread = u(11), task = u(43), tom = u(42), booking = u(45), tag = u(48);
const scope = { epoch: 'one', userId: user, organisationId: org };
const maya = { kind: 'person', id: user, name: 'Maya Chen' }, tomActor = { kind: 'person', id: tom, name: 'Tom Reilly' };
const names = { people: { [user]: 'Maya Chen', [tom]: 'Tom Reilly' }, tags: { [tag]: 'Production' } };
// Friday 2 October 2026, 9:40 am in Sydney.
const words: HistoryWords = { now: Date.parse('2026-10-01T23:40:00.000Z'), zone: 'Australia/Sydney' };
type Raw = Record<string, unknown>;
const entry = (n: number, x: Raw = {}): Raw => ({ id: u(n), changeIds: [u(n)], recordKind: 'task', recordId: task, operation: 'update', field: 'due', fields: ['due'], itemKind: null, itemId: null,
	before: '2026-10-06', after: '2026-10-08', reverses: [], state: 'reversible', ...x });
const set = (n: number, at: string, changes: Raw[], x: Raw = {}): Raw => ({ id: u(n), actor: maya, causeKind: 'request', reversesChangeSetId: null, createdAt: at, changes, ...x });
const page = (sets: Raw[], x: Raw = {}): Raw => ({ record: { kind: 'task', id: task, revision: 5, exists: true }, changeSets: sets, nextCursor: null,
	start: { kind: 'baseline', changeSetId: u(200), at: '2026-09-21T00:00:00.000Z', revision: 1 }, names, ...x });
const later = { id: u(302), changeSetId: u(202), actor: maya, at: '2026-10-01T06:40:00.000Z', field: 'due', before: '2026-10-06', after: '2026-10-08' };
const tagRow = { threadId: thread, tagId: tag, addedBy: user, addedAt: '2026-10-01T06:40:00.000Z' };
const time = (n: number, x: Raw = {}): Raw => entry(n, { recordKind: 'reservation', recordId: booking, changeIds: [u(n), u(n + 1)], field: 'time', fields: ['startsAt', 'endsAt'],
	before: { startsAt: '2026-10-07T21:00:00+00:00', endsAt: '2026-10-08T01:00:00+00:00' }, after: { startsAt: '2026-10-09T02:00:00+00:00', endsAt: '2026-10-09T06:00:00+00:00' }, ...x });
const asEntry = (x: Raw) => parseChangeSet(set(1, '2026-10-01T06:40:00.000Z', [x])).changes[0]!;

test('history pages parse strictly: identity, order, the start marker only on the last page, states and their companions', () => {
	const ok = parseHistory(page([set(201, '2026-10-01T23:12:00.000Z', [entry(301, { field: 'ownerId', fields: ['ownerId'], before: user, after: tom })]),
		set(202, '2026-10-01T06:40:00.000Z', [entry(302), entry(303, { operation: 'attach', field: null, fields: [], itemKind: 'tag', itemId: tag, before: null, after: tagRow })]),
		set(203, '2026-09-30T04:14:00.000Z', [entry(304, { before: '2026-10-02', after: '2026-10-06', state: 'conflict', later: [later] })])]), { kind: 'task', id: task });
	assert.deepEqual(ok.changeSets.map((s) => s.changes.map((c) => c.state)), [['reversible'], ['reversible', 'reversible'], ['conflict']]);
	const base = page([set(202, '2026-10-01T06:40:00.000Z', [entry(302)])]);
	const bad: Raw[] = [
		{ ...base, extra: true },
		{ ...base, record: { kind: 'task', id: u(99), revision: 5, exists: true } },
		{ ...base, nextCursor: 'abc' },
		page([set(1, '2026-09-01T00:00:00.000Z', [entry(301)]), set(2, '2026-10-01T00:00:00.000Z', [entry(302)])]),
		page([set(1, '2026-10-01T00:00:00.000Z', [entry(301, { state: 'needs', needs: [u(301)] })])]),
		page([set(1, '2026-10-01T00:00:00.000Z', [entry(301, { state: 'conflict', later: [] })])]),
		page([set(1, '2026-10-01T00:00:00.000Z', [entry(301, { state: 'irreversible' })])]),
		page([set(1, '2026-10-01T00:00:00.000Z', [entry(301, { recordId: u(77) })])]),
		page([set(1, '2026-10-01T00:00:00.000Z', [entry(301, { operation: 'attach', field: null, fields: [], itemKind: 'step', itemId: tag, before: null, after: tagRow })])]),
		page([set(1, '2026-10-01T00:00:00.000Z', [entry(301, { reverses: [u(1)] })])]),
		page([set(1, '2026-10-01T00:00:00.000Z', [entry(301)], { causeKind: 'message' })]),
		page([set(1, '2026-10-01T00:00:00.000Z', [entry(301)], { causeKind: 'reversal' })]),
		page([set(1, '2026-10-01T00:00:00.000Z', [entry(301, { field: 'Due' })])]),
		page([set(1, '2026-10-01T00:00:00.000Z', [time(311, { recordKind: 'task', recordId: task })])])
	];
	for (const [i, raw] of bad.entries()) assert.throws(() => parseHistory(raw, { kind: 'task', id: task }), TypeError, `case ${i}`);
	// A coupled group is one entry: its values are objects of exactly its fields, one id each.
	const group = parseHistory({ ...page([set(211, '2026-10-01T22:05:00.000Z', [time(311)])]), record: { kind: 'reservation', id: booking, revision: 3, exists: true } }, { kind: 'reservation', id: booking });
	assert.deepEqual(group.changeSets[0]!.changes[0]!.changeIds, [u(311), u(312)]);
	assert.throws(() => parseHistory({ ...page([set(211, '2026-10-01T22:05:00.000Z', [time(311, { before: { startsAt: 'x' } })])]), record: { kind: 'reservation', id: booking, revision: 3, exists: true } }, { kind: 'reservation', id: booking }));
	// A reason code this client does not know yet is kept, and worded honestly.
	const later2 = asEntry(entry(9, { state: 'irreversible', reason: 'something_new' }));
	assert.equal(stateWords(later2, words).note, 'Captain can’t undo this change. This app doesn’t know the reason Captain gave yet.');
});

test('previews, applies and stale answers parse strictly against what was asked', () => {
	const preview = { changes: [{ ...entry(302), now: '2026-10-08', proposed: '2026-10-06' }], basis: [{ recordKind: 'task', recordId: task, revision: 5 }], applicable: true, names };
	assert.equal(parsePreview(preview, [u(302)]).applicable, true);
	for (const raw of [{ ...preview, applicable: false }, { ...preview, basis: [] }, { ...preview, changes: [{ ...preview.changes[0], state: 'conflict', later: [later], proposed: '2026-10-06' }] },
		{ ...preview, changes: [{ ...preview.changes[0], now: undefined }] }, { ...preview, changes: [] }]) assert.throws(() => parsePreview(raw, [u(302)]));
	assert.throws(() => parsePreview(preview, [u(302), u(999)]), TypeError, 'every selected change is answered');
	// Blocked: a slot taken names the booking that holds it; any other code is open; needs names the entry's own ids.
	const blocked = parsePreview({ changes: [{ ...time(311), state: 'blocked', reason: 'slot_taken', detail: { reservationId: u(53), title: 'Keg wash', ownerId: tom, ownerName: 'Tom Reilly', occupiedStartsAt: '2026-10-07T20:30:00.000Z', occupiedEndsAt: '2026-10-08T01:30:00.000Z' },
		now: { startsAt: 'a', endsAt: 'b' }, proposed: { startsAt: 'c', endsAt: 'd' } }], basis: [{ recordKind: 'reservation', recordId: booking, revision: 3 }], applicable: false, names });
	assert.equal(blocked.changes[0]!.state, 'blocked');
	assert.throws(() => parsePreview({ changes: [{ ...time(311), state: 'blocked', reason: 'slot_taken', detail: { reservationId: u(53) }, now: null, proposed: null }], basis: [{ recordKind: 'reservation', recordId: booking, revision: 3 }], applicable: false, names }));
	const needs = parsePreview({ changes: [{ ...time(311), state: 'needs', needs: [u(312)], now: null, proposed: null }], basis: [{ recordKind: 'reservation', recordId: booking, revision: 3 }], applicable: false, names }, [u(311)]);
	assert.deepEqual(needs.changes[0]!.state === 'needs' && needs.changes[0]!.needs, [u(312)]);
	assert.throws(() => parsePreview({ changes: [{ ...time(311), state: 'needs', needs: [u(999)], now: null, proposed: null }], basis: [{ recordKind: 'reservation', recordId: booking, revision: 3 }], applicable: false, names }));
	const applied = { changeSet: set(630, '2026-10-01T23:31:00.000Z', [entry(731, { before: '2026-10-08', after: '2026-10-06', reverses: [u(302)] })], { causeKind: 'reversal', reversesChangeSetId: u(202) }), reversed: [u(302)] };
	assert.equal(parseApplied(applied, { id: u(630), changeIds: [u(302)] }).changeSet.id, u(630));
	assert.throws(() => parseApplied(applied, { id: u(631), changeIds: [u(302)] }), TypeError, 'the id sent');
	assert.throws(() => parseApplied(applied, { id: u(630), changeIds: [u(302), u(303)] }), TypeError, 'the ids sent');
	assert.throws(() => parseApplied({ ...applied, changeSet: { ...applied.changeSet, causeKind: 'request', reversesChangeSetId: null } }, { id: u(630), changeIds: [u(302)] }));
	assert.equal(parseStale({ preview, moved: [{ recordKind: 'task', recordId: task, revision: 6 }] }).moved[0]!.revision, 6);
	assert.throws(() => parseStale({ preview, moved: [], extra: 1 }));
	const version = parseVersion({ recordKind: 'task', recordId: task, revision: 1, changeSetId: u(200), createdAt: '2026-09-21T00:00:00.000Z', removed: false, snapshot: { row: { title: 'Pack', due: '2026-10-02' }, steps: [], tags: [tag] } }, { kind: 'task', id: task, revision: 1 });
	assert.deepEqual(versionLines(version.snapshot, 'task', names, words).map((l) => `${l.label}: ${l.value}`), ['Title: Pack', 'Due date: Fri 2 Oct', 'Steps: None', 'Tags: Production']);
	assert.throws(() => parseVersion({ recordKind: 'task', recordId: task, revision: 2, changeSetId: u(200), createdAt: '2026-09-21T00:00:00.000Z', removed: false, snapshot: { row: {} } }, { kind: 'task', id: task, revision: 1 }));
	// The client keeps a refusal's extra body (and only that) for its caller; a body with nothing more gives none.
	const stale = apiOutcome({ kind: 'answered', status: 409, body: { readable: true, value: { ok: false, code: 'stale_preview', error: 'x', preview, moved: [] } } }, () => null);
	assert.deepEqual(stale, { ok: false, kind: 'refused', status: 409, code: 'stale_preview', detail: { preview, moved: [] } });
	assert.deepEqual(apiOutcome({ kind: 'answered', status: 409, body: { readable: true, value: { ok: false, code: 'stale_revision', error: 'x' } } }, () => null), { ok: false, kind: 'refused', status: 409, code: 'stale_revision' });
});

test('a change in History reads as its change line does; states, reasons, values and the start are worded by code', () => {
	const due = asEntry(entry(302));
	assert.equal(plainText(entrySentence(due, { causeKind: 'request' }, names, words)), 'Changed the due date from Tue 6 Oct to Thu 8 Oct');
	assert.equal(plainText(entrySentence(due, { causeKind: 'reversal' }, names, words)), 'Changed the due date back from Tue 6 Oct to Thu 8 Oct');
	const line = wordChangeLine({ actorKind: 'person', actorId: user, actorName: 'Maya Chen', causeKind: 'reversal', createdAt: '2026-10-01T23:31:00.000Z', truncated: false,
		changes: entryChanges(due) }, { year: 2026 }).text;
	assert.equal(line, 'Maya changed the due date back from Tue 6 Oct to Thu 8 Oct', 'the thread says it the same way');
	const t = asEntry(time(311, { recordKind: 'reservation', recordId: booking }));
	assert.equal(plainText(entrySentence(t, { causeKind: 'request' }, names, words)), 'Changed the time from Thu 8 Oct, 8:00 am–12:00 pm to Fri 9 Oct, 1:00 pm–5:00 pm');
	assert.deepEqual(entryChanges(t).map((c) => [c.id, c.field]), [[u(311), 'startsAt'], [u(312), 'endsAt']]);
	const status = asEntry(entry(320, { field: 'status', fields: ['status'], before: { status: 'open' }, after: { status: 'in_progress' } }));
	assert.equal(plainText(entrySentence(status, { causeKind: 'request' }, names, words)), 'Changed the status from Open to In progress', 'a one-field coupled group');
	assert.equal(wordDate('2026-09-30', 2026), 'Wed 30 Sep');
	// A stock count: the count with when and by whom, one entry, worded with the unit.
	const count = asEntry(entry(330, { recordKind: 'stock_item', field: 'count', fields: ['currentCount', 'countedAt', 'countedBy'], changeIds: [u(330), u(331), u(332)],
		before: { currentCount: '4.5', countedAt: '2026-10-01T04:10:00.000Z', countedBy: tom }, after: { currentCount: '2', countedAt: '2026-10-01T23:00:00.000Z', countedBy: user } }));
	assert.equal(plainText(entrySentence(count, { causeKind: 'request' }, names, { ...words, unit: 'kg' })), 'Changed the count from 4.5 kg to 2 kg');
	assert.deepEqual([valueWords({ ...count, now: count.after, proposed: count.before } as PreviewEntry, 'proposed', names, { ...words, unit: 'kg' })], ['4.5 kg']);
	assert.equal(setTime('2026-10-01T23:12:00.000Z', words), 'Today, 9:12 am'); assert.equal(setTime('2026-10-01T06:40:00.000Z', words), 'Thu 1 Oct, 4:40 pm');

	const conflict = asEntry(entry(304, { before: '2026-10-02', after: '2026-10-06', state: 'conflict', later: [later] })) as Entry & { state: 'conflict' };
	assert.deepEqual(stateWords(conflict, words), { badge: 'Changed since', note: 'The due date was changed again on Thu 1 Oct.', tickable: true });
	assert.deepEqual(conflictWords(conflict, names, words), { note: 'The due date was changed again after this: Maya moved it from Tue 6 Oct to Thu 8 Oct on Thu 1 Oct. Captain won’t choose between them.',
		also: 'Also undo the change of Thu 1 Oct. The due date goes back to Fri 2 Oct.' });
	const reversed = asEntry(entry(307, { state: 'reversed', reversedBy: { changeId: u(306), changeSetId: u(204), actor: maya, at: '2026-09-29T23:00:00.000Z' } }));
	assert.deepEqual(stateWords(reversed, words), { badge: 'Undone', note: 'Undone by Maya Chen on Wed 30 Sep.', tickable: false });
	assert.equal(isTickable(reversed), false); assert.equal(isTickable(conflict), true);
	const created = (kind: string) => asEntry(entry(1, { recordKind: kind, operation: 'create', field: null, fields: [], before: null, after: { id: task }, state: 'irreversible', reason: 'record_created' }));
	assert.deepEqual(['task', 'reservation', 'stock_item', 'thread'].map((k) => irreversibleReason('record_created', created(k))),
		['Cancel or complete it instead.', 'Cancel the booking instead.', 'Archive the item instead.', 'Change it or remove it instead.']);
	for (const reason of ['record_removed', 'record_gone', 'item_gone', 'tag_gone', 'became_task', 'provider_owned', 'external_effect'])
		assert.doesNotMatch(irreversibleReason(reason, due), /doesn’t know/, reason);
	// Every blocked code in the contract has its own sentence; an unknown one is honest.
	const blocked = (reason: string, detail: unknown = null) => ({ ...due, state: 'blocked', reason, detail, now: '2026-10-08', proposed: '2026-10-06' }) as PreviewEntry & { state: 'blocked' };
	for (const reason of ['invalid_time', 'equipment_archived', 'reservation_cancelled', 'evidence_required', 'step_has_evidence', 'evidence_kind_retired', 'owner_inactive', 'task_unavailable', 'tag_archived',
		'stock_archived', 'stock_unit_counted', 'supplier_unavailable', 'name_taken', 'tag_dates_invalid', 'recurrence_invalid', 'equipment_in_use']) assert.doesNotMatch(blockedReason(blocked(reason), names, words), /doesn’t know/, reason);
	assert.equal(blockedReason(blocked('already_current'), names, words), 'There is nothing to undo: the due date is already Thu 8 Oct.');
	assert.match(blockedReason(blocked('brand_new'), names, words), /doesn’t know the reason/);
	assert.equal(blockedReason({ ...blocked('slot_taken', { reservationId: u(53), title: 'Keg wash', ownerId: tom, ownerName: 'Tom Reilly', occupiedStartsAt: '2026-10-07T20:30:00.000Z', occupiedEndsAt: '2026-10-08T01:30:00.000Z' }) }, names, { ...words, equipmentName: 'Canning line' }),
		'This can’t be undone now. Keg wash (Tom Reilly) holds the Canning line on Thu 8 Oct from 7:30 am to 12:30 pm.');
	// Values: an item's presence, a coupled time, not decided.
	const attach = { ...asEntry(entry(303, { operation: 'attach', field: null, fields: [], itemKind: 'tag', itemId: tag, before: null, after: tagRow })), now: tagRow, proposed: null } as PreviewEntry;
	assert.deepEqual([valueWords(attach, 'now', names, words), valueWords(attach, 'proposed', names, words)], ['On this task', 'Removed']);
	const timePreview = { ...t, now: t.after, proposed: t.before } as PreviewEntry;
	assert.deepEqual([valueWords(timePreview, 'now', names, words), valueWords(timePreview, 'proposed', names, words)], ['Fri 9 Oct, 1:00 pm to 5:00 pm', 'Thu 8 Oct, 8:00 am to 12:00 pm']);
	assert.equal(valueWords({ ...conflict, now: '2026-10-08', proposed: null } as PreviewEntry, 'proposed', names, words), 'Not decided');
	// The stale sheet: who moved what, and the button for what still applies.
	const freshConflict = { ...due, state: 'conflict', later: [{ ...later, actor: tomActor, at: '2026-10-01T23:30:00.000Z', before: '2026-10-08', after: '2026-10-09' }], now: '2026-10-09', proposed: null } as PreviewEntry;
	assert.equal(staleAlert([freshConflict], names, words), 'Tom changed the due date at 9:30 am, so this preview was out of date. Here it is again.');
	assert.equal(remainingLabel([attach], 2, names, words), 'Undo the tag only'); assert.equal(remainingLabel([attach, due as PreviewEntry], 2, names, words), 'Undo 2 changes');
	assert.equal(untouched([{ entry: asEntry(entry(301, { field: 'ownerId', fields: ['ownerId'], before: user, after: tom })), set: parseChangeSet(set(201, '2026-10-01T23:12:00.000Z', [entry(301)], { actor: tomActor })) }], words),
		'Everything else stays as it is, including Tom’s change of owner today.');
	assert.deepEqual(startWords({ kind: 'baseline', changeSetId: u(200), at: '2026-09-21T00:00:00.000Z', revision: 1 }, 'task', words),
		{ text: 'History starts on Mon 21 Sep 2026, when Captain began keeping it.', link: 'See the task as it was then' });
	assert.equal(historyRoute(thread, u(202)), `/threads/${thread}/history?changeSet=${u(202)}`); assert.equal(historyRoute('x', u(202)), null);
});

function memory() {
	const values = new Map<string, string>();
	const raw: WebStorage = { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => { values.set(k, v); }, removeItem: (k) => { values.delete(k); }, key: (i) => [...values.keys()][i] ?? null, get length() { return values.size; } };
	return { values, raw, store: createPendingUndoStorage(() => raw) };
}

test('the pending undo store keeps only the id, change ids and basis, per person and organisation, and refuses anything else', () => {
	const { values, raw, store } = memory();
	const body = { id: u(650), changeIds: [u(302)], basis: [{ recordKind: 'task' as const, recordId: task, revision: 5 }] };
	assert.equal(store.save(scope, thread, body), true);
	assert.deepEqual([...values.keys()], [`captain.pending-undo.${user}.${org}.${thread}`]);
	assert.deepEqual(store.load(scope, thread), body);
	assert.equal(store.load({ ...scope, organisationId: u(3) }, thread), null);
	raw.setItem(`captain.pending-undo.${user}.${org}.${thread}`, JSON.stringify({ ...body, preview: {} }));
	assert.equal(store.load(scope, thread), null); assert.equal(values.size, 0, 'an unknown shape is dropped');
	store.save(scope, thread, body); store.save({ ...scope, userId: tom }, thread, body);
	store.person(user); assert.deepEqual([...values.keys()], [`captain.pending-undo.${user}.${org}.${thread}`]);
	store.person(null); assert.equal(values.size, 0);
});

function fixture() {
	const sets: Raw[] = [set(201, '2026-10-01T23:12:00.000Z', [entry(301, { field: 'ownerId', fields: ['ownerId'], before: user, after: tom })]),
		set(202, '2026-10-01T06:40:00.000Z', [entry(302), entry(303, { operation: 'attach', field: null, fields: [], itemKind: 'tag', itemId: tag, before: null, after: tagRow })]),
		set(203, '2026-09-30T04:14:00.000Z', [entry(304, { before: '2026-10-02', after: '2026-10-06', state: 'conflict', later: [later] })])];
	const detail = { thread: { id: thread, kind: 'record', title: 'Package summer lager', revision: 2, lastSeq: 1, lastChange: 1, readPosition: 1, unread: 0, starred: false, createdAt: '2026-09-21T00:00:00.000Z' },
		card: { record: { kind: 'task', id: task }, title: 'Package summer lager', status: 'in_progress', facts: ['Tom Reilly', '2026-10-08'], fold: { body: '', status: 'in_progress', ownerId: tom, ownerName: 'Tom Reilly', due: '2026-10-08', evidenceRequired: false, seriesId: null, open: null } }, tags: [], pin: null };
	const sent: { method: string; path: string; body: unknown }[] = [];
	let current: typeof scope | null = scope, applyAnswer: (body: Raw) => ApiOutcome<unknown> = () => ({ ok: false, kind: 'unavailable', status: 503 }), hold: Promise<void> | null = null;
	const pending = (v: Raw) => v;
	const client: ApiClient = {
		async get(path, _t, parse) {
			sent.push({ method: 'GET', path, body: undefined }); if (hold) await hold;
			const p = new URL(path, 'https://x').pathname;
			if (p.includes('/history/')) return { ok: true, value: parse(page(sets)) };
			if (p.endsWith(`/threads/${thread}`)) return { ok: true, value: parse(detail) };
			return { ok: false, kind: 'unavailable', status: 503 };
		},
		async post(path, _t, body, parse) {
			sent.push({ method: 'POST', path, body });
			if (path.endsWith('/reversals/preview')) {
				const ids = (body as { changeIds: string[] }).changeIds;
				const changes: Raw[] = ids.map((id): Raw => id === u(304) && !ids.includes(u(302)) ? { ...entry(304, { before: '2026-10-02', after: '2026-10-06', state: 'conflict', later: [later] }), now: '2026-10-08', proposed: null }
					: id === u(303) ? { ...entry(303, { operation: 'attach', field: null, fields: [], itemKind: 'tag', itemId: tag, before: null, after: tagRow }), now: tagRow, proposed: null }
						: { ...entry(Number(id.slice(-12))), now: '2026-10-08', proposed: '2026-10-06' });
				return { ok: true, value: parse({ changes, basis: [{ recordKind: 'task', recordId: task, revision: 5 }], applicable: changes.every((c) => c.state === 'reversible'), names }) };
			}
			const a = applyAnswer(body as Raw);
			if (a.ok) return { ok: true, value: parse(a.value) };
			return a as ApiOutcome<never>;
		},
		async patch() { return { ok: false, kind: 'unavailable', status: 503 }; }, async delete() { return { ok: false, kind: 'unavailable', status: 503 }; }
	};
	const calls = createThreadCalls(client, { scope: () => current, sessionEnded() {}, reconcile() {} });
	const mem = memory();
	let n = 900, clock = 0;
	const h = createHistory({ calls, scope, threadId: thread, now: () => clock, randomId: () => u(++n), storage: mem.store });
	return { h, sent, sets, mem, pending, advance: (ms: number) => { clock += ms; }, setApply: (f: typeof applyAnswer) => { applyAnswer = f; }, setScope: (s: typeof current) => { current = s; }, setHold: (p: Promise<void> | null) => { hold = p; } };
}
const reversalSet = (id: string, changeIds: string[]) => set(Number(id.slice(-12)), '2026-10-01T23:31:00.000Z', changeIds.map((c, i) => entry(800 + i, { reverses: [c] })), { causeKind: 'reversal', reversesChangeSetId: u(202) });

test('History: load, tick, preview, also undo a later change, and apply once with the preview’s basis', async () => {
	const f = fixture();
	await f.h.load();
	const s = f.h.snapshot();
	assert.deepEqual([s.phase, s.target, s.sets.length, s.detail?.card.title], ['ready', { kind: 'task', id: task }, 3, 'Package summer lager']);
	assert.deepEqual(targetOf(s.detail!), { kind: 'task', id: task });
	const index = entryIndex(s.sets);
	f.h.toggle(index.get(u(304))!.entry); f.h.openPreview();
	await new Promise((r) => setImmediate(r));
	assert.equal(f.h.snapshot().sheet?.preview?.applicable, false);
	f.h.apply(); assert.equal(f.sent.filter((x) => x.path.endsWith('/reversals')).length, 0, 'a conflict never applies');
	f.h.add([u(302)]); await new Promise((r) => setImmediate(r));
	assert.deepEqual(f.h.snapshot().sheet?.selection, [u(304), u(302)]); assert.deepEqual(f.h.snapshot().selected, [u(304), u(302)]);
	assert.equal(f.h.snapshot().sheet?.preview?.applicable, true);
	f.setApply((b) => { f.sets.unshift(reversalSet(b.id as string, b.changeIds as string[])); return { ok: true, value: { changeSet: reversalSet(b.id as string, b.changeIds as string[]), reversed: [...(b.changeIds as string[])].sort() } }; });
	f.h.apply(); await new Promise((r) => setTimeout(r, 10));
	const applies = f.sent.filter((x) => x.path.endsWith('/reversals'));
	assert.deepEqual(applies.map((x) => x.body), [{ id: u(901), changeIds: [u(304), u(302)], basis: [{ recordKind: 'task', recordId: task, revision: 5 }] }]);
	assert.deepEqual([f.h.snapshot().sheet, f.h.snapshot().selected, f.h.snapshot().notice, f.h.snapshot().sets[0]!.id], [null, [], '2 changes undone.', u(901)]);
	assert.equal(f.mem.values.size, 0, 'nothing stored after a confirmed undo');
});

test('History: an uncertain undo keeps its id and body for an explicit retry, stores only those, and is reconciled by History', async () => {
	const f = fixture();
	await f.h.load();
	f.h.toggle(entryIndex(f.h.snapshot().sets).get(u(301))!.entry); f.h.openPreview(); await new Promise((r) => setImmediate(r));
	f.h.apply(); await new Promise((r) => setTimeout(r, 5));
	assert.equal(f.h.snapshot().sheet?.phase, 'uncertain');
	const first = f.sent.filter((x) => x.path.endsWith('/reversals'))[0]!.body;
	assert.deepEqual(JSON.parse([...f.mem.values.values()][0]!), first);
	f.h.closeSheet(); assert.equal(f.h.snapshot().sheet?.phase, 'uncertain', 'it cannot be dismissed while uncertain');
	f.h.apply(); assert.equal(f.sent.filter((x) => x.path.endsWith('/reversals')).length, 1, 'never retried by itself, nor by a second press of apply');
	f.h.retry(); await new Promise((r) => setTimeout(r, 5));
	const tries = f.sent.filter((x) => x.path.endsWith('/reversals')).map((x) => x.body);
	assert.deepEqual(tries, [first, first]);
	// The undo did happen: History shows its change set, which settles it.
	f.sets.unshift(reversalSet((first as { id: string }).id, [u(301)]));
	f.h.check(); await new Promise((r) => setTimeout(r, 5));
	assert.deepEqual([f.h.snapshot().sheet, f.h.snapshot().notice, f.mem.values.size], [null, '1 change undone.', 0]);
	// From storage on a later visit: offered again with the same id, then reconciled.
	const g = fixture();
	g.mem.store.save(scope, thread, { id: u(650), changeIds: [u(302)], basis: [{ recordKind: 'task', recordId: task, revision: 5 }] });
	await g.h.load(); assert.equal(g.h.snapshot().recovered?.id, u(650));
	g.setApply((b) => ({ ok: true, value: { changeSet: reversalSet(b.id as string, b.changeIds as string[]), reversed: [u(302)] } }));
	await g.h.retryRecovered();
	assert.deepEqual(g.sent.filter((x) => x.path.endsWith('/reversals')).map((x) => (x.body as { id: string }).id), [u(650)]);
	assert.deepEqual([g.h.snapshot().recovered, g.h.snapshot().notice, g.mem.values.size], [null, '1 change undone.', 0]);
});

test('History: a stale answer shows the fresh preview and applies only what still can; a 429 keeps the id; a late answer is dropped', async () => {
	const f = fixture();
	await f.h.load();
	const index = entryIndex(f.h.snapshot().sets);
	f.h.toggle(index.get(u(302))!.entry); f.h.toggle(index.get(u(303))!.entry); f.h.openPreview(); await new Promise((r) => setImmediate(r));
	const fresh = { changes: [{ ...entry(302, { state: 'conflict', later: [{ ...later, id: u(331), changeSetId: u(231), actor: tomActor, at: '2026-10-01T23:30:00.000Z', before: '2026-10-08', after: '2026-10-09' }] }), now: '2026-10-09', proposed: null },
		{ ...entry(303, { operation: 'attach', field: null, fields: [], itemKind: 'tag', itemId: tag, before: null, after: tagRow }), now: tagRow, proposed: null }], basis: [{ recordKind: 'task', recordId: task, revision: 6 }], applicable: false, names };
	f.setApply(() => ({ ok: false, kind: 'refused', status: 409, code: 'stale_preview', detail: { preview: fresh, moved: [{ recordKind: 'task', recordId: task, revision: 6 }] } }));
	f.h.apply(); await new Promise((r) => setTimeout(r, 5));
	const sheet = f.h.snapshot().sheet!;
	assert.deepEqual([sheet.phase, sheet.stale?.moved.length, sheet.preview?.changes.map((c) => c.state), f.mem.values.size], ['ready', 1, ['conflict', 'reversible'], 0]);
	f.setApply(() => ({ ok: false, kind: 'unavailable', status: 429, retryAfter: 0 }));
	f.h.apply(); await new Promise((r) => setTimeout(r, 5));
	const [, limited] = f.sent.filter((x) => x.path.endsWith('/reversals')).map((x) => x.body as Raw);
	assert.deepEqual(limited, { id: u(902), changeIds: [u(303)], basis: [{ recordKind: 'task', recordId: task, revision: 6 }] }, 'what still applies, with the fresh basis and a new id');
	f.setApply((b) => ({ ok: true, value: { changeSet: reversalSet(b.id as string, b.changeIds as string[]), reversed: [u(303)] } }));
	f.h.apply(); assert.equal(f.sent.filter((x) => x.path.endsWith('/reversals')).length, 2, 'not before the wait');
	f.advance(1000); f.h.apply(); await new Promise((r) => setTimeout(r, 5));
	assert.equal((f.sent.filter((x) => x.path.endsWith('/reversals')).at(-1)!.body as Raw).id, u(902), 'after a 429 the same intent keeps its id');
	assert.equal(f.h.snapshot().notice, '1 change undone.');
	// A different person or organisation by the time an answer arrives: dropped.
	const g = fixture();
	let release!: () => void; g.setHold(new Promise<void>((r) => { release = r; }));
	const loading = g.h.load(); g.setScope({ ...scope, epoch: 'two' }); release(); await loading;
	assert.equal(g.h.snapshot().phase, 'loading', 'nothing from the old scope is shown');
});

test('make this a task: the body carries the revision and change set id; the answer must be this thread, now a task’s', () => {
	assert.deepEqual(makeTaskBody(u(9), 2, user, ''), { changeSetId: u(9), expectedRevision: 2, ownerId: user });
	assert.deepEqual(makeTaskBody(u(9), 2, null, '2026-10-05'), { changeSetId: u(9), expectedRevision: 2, ownerId: null, due: '2026-10-05' });
	const detail = { thread: { id: thread, kind: 'record', title: 'Order pallet wrap', revision: 3, lastSeq: 2, lastChange: 2, readPosition: 2, unread: 0, starred: false, createdAt: '2026-10-01T22:41:00.000Z' },
		card: { record: { kind: 'task', id: task }, title: 'Order pallet wrap', status: 'open', facts: ['Maya Chen', ''], fold: { body: '', status: 'open', ownerId: user, ownerName: 'Maya Chen', due: null, evidenceRequired: false, seriesId: null, open: null } }, tags: [], pin: null };
	assert.equal(parseMadeTask(detail, thread).card.record?.id, task);
	assert.throws(() => parseMadeTask(detail, u(12)));
	assert.throws(() => parseMadeTask({ ...detail, thread: { ...detail.thread, kind: 'topic' }, card: { record: null, title: 'x', status: null, facts: ['', ''], fold: { createdBy: null, open: null } } }, thread));
});
