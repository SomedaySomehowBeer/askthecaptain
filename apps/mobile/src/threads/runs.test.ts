import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChangeLine, LineChange, Message } from './contracts.ts';
import { firstUnread, quietLine } from './derive.ts';
import { changeRuns, displayItems, itemMessages } from './runs.ts';
import { unfoldLabel, wordFoldedRun, wordNames, wordSpan } from './wording.ts';

// Runs of change lines (owner decision, 3 October 2026): consecutive change lines fold to one line; presentation only.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const thread = id(1), task = id(2), me = id(3), maya = id(4), tom = id(5), tag = id(6);
let n = 100;
const change = (c: Partial<LineChange>): LineChange => ({ id: id(n++), recordKind: 'task', recordId: task, operation: 'update', field: 'title', itemKind: null, itemId: null, before: 'A', after: 'B', ...c });
const base = (seq: number, createdAt: string) => ({ id: id(1000 + seq), threadId: thread, seq, changeSeq: seq, createdAt, editedAt: null, deletedAt: null, deletedBy: null, revision: 1 });
const say = (seq: number, author = maya, at = '2026-10-05T01:00:00.000Z'): Message => ({ ...base(seq, at), kind: 'message', authorId: author, authorName: author === maya ? 'Maya Chen' : 'Tom Reilly', body: `Message ${seq}` });
const line = (seq: number, actor: string | null = maya, extra: Partial<ChangeLine> = {}, at = '2026-10-05T02:00:00.000Z'): Message => {
	const name = actor === maya ? 'Maya Chen' : actor === tom ? 'Tom Reilly' : actor === me ? 'Me Myself' : null;
	const change: ChangeLine = { actorKind: actor ? 'person' : 'system', actorId: actor, actorName: name, causeKind: actor ? 'request' : 'routine', createdAt: at,
		changes: [{ id: id(n++), recordKind: 'task', recordId: task, operation: 'update', field: 'title', itemKind: null, itemId: null, before: `T${seq - 1}`, after: `T${seq}` }], truncated: false, ...extra };
	return { ...base(seq, at), kind: 'change', authorId: actor, authorName: name, body: null, changeSetId: id(2000 + seq), change };
};
const kinds = (items: ReturnType<typeof displayItems>) => items.map((i) => i.kind === 'foldedRun' ? `run:${i.lines.map((l) => l.seq).join(',')}` : `${i.kind}:${i.message.seq}`);

test('consecutive change lines fold to one item; a message, a tombstone or a gap ends a run; a run of one shows as a line', () => {
	const tombstone: Message = { ...say(6), body: null, deletedAt: '2026-10-05T03:00:00.000Z', deletedBy: maya };
	const messages = [say(1), line(2), line(3, tom), line(4), say(5), tombstone, line(7), line(8), line(10), line(11), say(12)];
	assert.deepEqual(changeRuns(messages).map((r) => r.map((m) => m.seq)), [[2, 3, 4], [7, 8], [10, 11]], 'seq 9 is not loaded: the gap splits');
	assert.deepEqual(kinds(displayItems(messages)), ['message:1', 'run:2,3,4', 'message:5', 'message:6', 'run:7,8', 'run:10,11', 'message:12']);
	assert.deepEqual(kinds(displayItems([say(1), line(2), say(3)])), ['message:1', 'changeLine:2', 'message:3'], 'a run of one is the line as today');
	const run = displayItems(messages)[1]!;
	assert.ok(run.kind === 'foldedRun');
	assert.deepEqual([run.key, run.newest.seq, run.actors, run.from, run.to], [id(1002), 4, ['Maya', 'Tom'], '2026-10-05T02:00:00.000Z', '2026-10-05T02:00:00.000Z']);
	assert.deepEqual(itemMessages(run).map((m) => m.seq), [2, 3, 4]);
	// Folding is presentation only: every message is still there, once, in order.
	assert.deepEqual(displayItems(messages).flatMap(itemMessages), messages);
});

test('a tapped run unfolds in place, each line as today, and stays unfolded as newer lines join it', () => {
	const messages = [say(1), line(2), line(3), say(4), line(5), line(6)];
	assert.deepEqual(kinds(displayItems(messages, { unfolded: new Set([id(1002)]) })), ['message:1', 'changeLine:2', 'changeLine:3', 'message:4', 'run:5,6']);
	assert.deepEqual(kinds(displayItems([...messages.slice(0, 3), line(4)], { unfolded: new Set([id(1002)]) })), ['message:1', 'changeLine:2', 'changeLine:3', 'changeLine:4']);
});

test('the first unread inside a run unfolds it so the marker is on that line; at the run’s first line the run stays folded and carries it', () => {
	const messages = [say(1), line(2), line(3), line(4), say(5)];
	assert.deepEqual(kinds(displayItems(messages, { firstUnreadSeq: 3 })), ['message:1', 'changeLine:2', 'changeLine:3', 'changeLine:4', 'message:5']);
	assert.deepEqual(kinds(displayItems(messages, { firstUnreadSeq: 2 })), ['message:1', 'run:2,3,4', 'message:5']);
	assert.deepEqual(kinds(displayItems(messages, { firstUnreadSeq: 5 })), ['message:1', 'run:2,3,4', 'message:5']);
	// The read position in the middle of a run: the first unread is its next line by someone else.
	assert.equal(firstUnread(messages, 2, me)?.seq, 3);
	assert.equal(firstUnread([line(1, me), line(2, me), line(3)], 0, me)?.seq, 3, 'my own lines are never unread');
});

test('a system creation line is quiet: never the first unread, still shown', () => {
	const created = (extra: LineChange[] = []) => line(1, null, { changes: [change({ operation: 'create', field: null, before: null, after: { title: 'Excise return' } }), ...extra] });
	const occurrence = created([change({ operation: 'attach', field: null, itemKind: 'tag', itemId: tag, before: null, after: {} })]);
	assert.equal(quietLine(created()), true);
	assert.equal(quietLine(occurrence), true, 'a series occurrence with its tags');
	assert.equal(quietLine(line(1, null)), false, 'a system edit is not a creation');
	assert.equal(quietLine(line(1, null, { changes: [change({ operation: 'attach', field: null, itemKind: 'tag', itemId: tag, before: null, after: {} })] })), false, 'nor is a tag the system adds later');
	assert.equal(quietLine(line(1, maya, { changes: [change({ operation: 'create', field: null, before: null, after: {} })] })), false, 'a person’s creation is not quiet');
	assert.equal(quietLine(say(1)), false);
	assert.equal(firstUnread([occurrence], 0, me), null);
	assert.equal(firstUnread([occurrence, say(2, tom)], 0, me)?.seq, 2, 'a later message by another is the first unread');
	assert.deepEqual(kinds(displayItems([occurrence])), ['changeLine:1']);
});

test('the folded line: the newest in full, "and N earlier changes", the actors when several, and the dates when it crosses days', () => {
	const at = (day: number) => `2026-10-0${day}T02:00:00.000Z`;
	const lines = [line(1, maya, {}, at(5)), line(2, tom, {}, at(5)), line(3, maya, {}, at(6))].map((m) => m.change!);
	assert.equal(wordFoldedRun(lines).text, 'Maya changed the title from T2 to T3 and 2 earlier changes by Maya and Tom');
	assert.equal(wordFoldedRun(lines.slice(0, 1).concat(lines.slice(2))).text, 'Maya changed the title from T2 to T3 and 1 earlier change', 'singular, one actor');
	assert.equal(wordFoldedRun(lines.slice(2)).text, 'Maya changed the title from T2 to T3', 'a run of one is its line');
	assert.deepEqual(wordFoldedRun(lines).segments.filter((s) => s.strong).map((s) => s.text), ['Maya', 'T2', 'T3']);
	assert.equal(wordFoldedRun([line(1, null).change!, line(2, maya).change!]).text, 'Maya changed the title from T1 to T2 and 1 earlier change by Captain and Maya');
	assert.deepEqual(['', 'Maya', 'Maya and Tom', 'Maya, Tom and Ana', 'Maya, Tom and 2 others'].map((s, i) => wordNames(['Maya', 'Tom', 'Ana', 'Ben'].slice(0, i))), ['', 'Maya', 'Maya and Tom', 'Maya, Tom and Ana', 'Maya, Tom and 2 others']);
	// Dates on the device's calendar: noon UTC is the same local day in any zone from UTC-11 to UTC+11.
	assert.equal(wordSpan('2026-10-05T12:00:00.000Z', '2026-10-05T12:30:00.000Z', 2026), null, 'one day: no span');
	assert.equal(wordSpan('2026-10-05T12:00:00.000Z', '2026-10-07T12:00:00.000Z', 2026), 'Mon 5 Oct – Wed 7 Oct');
	assert.equal(wordSpan('2025-12-31T12:00:00.000Z', '2026-01-02T12:00:00.000Z', 2026), 'Wed 31 Dec 2025 – Fri 2 Jan');
	assert.equal(unfoldLabel(3), 'Show all 3 changes');
});
