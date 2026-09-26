import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyChanges, applyMessages, applyPins, highestDisplayed, initialCursor, initialState, livePins, mergeRange, pageRange, reconcileIntent, streamRows, upsertMessages, type ThreadState } from './feed.ts';
import type { Change, ChangesPage, Message, MessagesPage, Pin, PinsPage } from './types.ts';

const cid = 'c0000000-0000-4000-8000-000000000001';
const id = (seq: number) => `m0000000-0000-4000-8000-${String(seq).padStart(12, '0')}`.replace(/^m/, 'a');
function msg(seq: number, over: Partial<Message> = {}): Message {
	return { id: id(seq), conversationId: cid, seq, changeSeq: seq, authorId: 'u', authorName: 'Ryan', body: `message ${seq}`, createdAt: '2026-09-27T09:00:00Z',
		editedAt: null, deletedAt: null, deletedBy: null, revision: 1, ...over };
}
const pinOf = (pinId: string, seq: number, changeSeq: number, over: Partial<Pin> = {}): Pin => ({ id: pinId, conversationId: cid, messageId: id(seq), changeSeq,
	pinnedBy: 'u', pinnedAt: '2026-09-27T09:00:00Z', unpinnedBy: null, unpinnedAt: null, ...over });
const messagesPage = (messages: Message[], lastSeq: number, hasMore: boolean, lastChange = lastSeq, revision = 1): MessagesPage =>
	({ conversation: { id: cid, revision, lastSeq, lastChange }, messages, hasMore });
const pinsPage = (pins: { pin: Pin; message: Message }[], lastChange: number): PinsPage =>
	({ conversation: { id: cid, revision: 1, lastChange }, pins: pins.map(({ pin, message }) => ({ ...pin, message })) });
const changes = (list: Change[], lastSeq: number, complete = true, next = list.at(-1)?.changeSeq ?? 0, revision = 1): ChangesPage =>
	({ conversation: { id: cid, revision, lastSeq, highWater: next }, changes: list, next, complete });
const m = (message: Message): Change => ({ changeSeq: message.changeSeq, kind: 'message', message });
const p = (pin: Pin): Change => ({ changeSeq: pin.changeSeq, kind: 'pin', pin });
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => msg(from + i));
const seqs = (s: ThreadState) => streamRows(s).map((r) => r.seq);

/** A thread showing the latest 5 of 20 (seqs 16–20), no pins. */
function thread(lastSeq = 20): ThreadState {
	return initialState(messagesPage(range(lastSeq - 4, lastSeq), lastSeq, lastSeq > 5), { latest: 5 }, pinsPage([], lastSeq));
}

test('pageRange covers each window shape, reaching the ends when there is no more', () => {
	assert.deepEqual(pageRange(messagesPage(range(16, 20), 20, true), { latest: 5 }), { from: 16, to: 20 });
	assert.deepEqual(pageRange(messagesPage(range(1, 3), 3, false), { latest: 5 }), { from: 1, to: 3 });
	assert.deepEqual(pageRange(messagesPage(range(8, 9), 20, true), { after: 7, limit: 2 }), { from: 8, to: 9 });
	assert.deepEqual(pageRange(messagesPage(range(8, 20), 20, false), { after: 7, limit: 50 }), { from: 8, to: 20 });
	assert.deepEqual(pageRange(messagesPage(range(11, 15), 20, true), { before: 16, limit: 5 }), { from: 11, to: 15 });
	assert.deepEqual(pageRange(messagesPage(range(1, 15), 20, false), { before: 16, limit: 50 }), { from: 1, to: 15 });
	assert.equal(pageRange(messagesPage([], 0, false), { latest: 50 }), null);
	assert.deepEqual(mergeRange([{ from: 1, to: 3 }, { from: 10, to: 12 }], { from: 4, to: 9 }), [{ from: 1, to: 12 }]);
});

test('the change cursor starts after the older snapshot', () => {
	assert.equal(initialCursor(messagesPage([], 5, false, 40), pinsPage([], 37)), 37);
	const s = initialState(messagesPage(range(1, 3), 3, false, 40), { latest: 50 }, pinsPage([], 44));
	assert.equal(s.cursor, 40);
	assert.equal(s.current, false, 'never current before catching up');
});

test('two consecutive sends L+1 and L+2 in one page extend the tail with no false gap', () => {
	const { state, gapFrom } = applyChanges(thread(), changes([m(msg(21)), m(msg(22))], 22));
	assert.equal(gapFrom, null);
	assert.deepEqual(state.ranges, [{ from: 16, to: 22 }]);
	assert.deepEqual(seqs(state), [16, 17, 18, 19, 20, 21, 22]);
	assert.equal(state.current, true, 'a complete page with no gap is current');
	// Delivered out of seq order within the page (an edit moved one later): still contiguous.
	const reordered = applyChanges(thread(), changes([m(msg(22, { changeSeq: 21 })), m(msg(21, { changeSeq: 23, revision: 2, editedAt: 'x' }))], 22));
	assert.equal(reordered.gapFrom, null);
	assert.deepEqual(seqs(reordered.state), [16, 17, 18, 19, 20, 21, 22]);
});

test('L+1 and L+3 extend to L+1 and open a gap at L+2 that keeps current false until it is loaded', () => {
	const { state, gapFrom } = applyChanges(thread(), changes([m(msg(21)), m(msg(23))], 23));
	assert.equal(gapFrom, 22);
	assert.deepEqual(state.ranges, [{ from: 16, to: 21 }]);
	assert.deepEqual(seqs(state), [16, 17, 18, 19, 20, 21], 'L+3 is known but not rendered on its own');
	assert.ok(state.messages.has(id(23)));
	assert.equal(state.current, false, 'complete page, but a gap is open');
	// Later ticks do not extend across the gap.
	const later = applyChanges(state, changes([m(msg(24, { changeSeq: 24 }))], 24, true, 24));
	assert.equal(later.gapFrom, 22);
	assert.equal(later.state.current, false);
	// Loading after the tail covers it, joins the ranges and makes the thread current.
	const filled = applyMessages(later.state, messagesPage(range(22, 24), 24, false), { after: 21, limit: 50 });
	assert.equal(filled.gapFrom, null);
	assert.deepEqual(filled.ranges, [{ from: 16, to: 24 }]);
	assert.equal(filled.current, true);
	// A partial load moves the gap forward instead.
	const partial = applyMessages(later.state, messagesPage(range(22, 22), 24, true), { after: 21, limit: 1 });
	assert.equal(partial.gapFrom, 23);
	assert.equal(partial.current, false);
});

test('tail extension is judged against the lastSeq known before the page', () => {
	// The tail (20) is short of the lastSeq already known (21): the first new seq opens a gap at 21.
	const behind = { ...thread(), lastSeq: 21 };
	const { gapFrom, state } = applyChanges(behind, changes([m(msg(22))], 22));
	assert.equal(gapFrom, 21);
	assert.deepEqual(state.ranges, [{ from: 16, to: 20 }]);
	// The page's own larger lastSeq does not count against it: 21 and 22 extend a tail at 20 with lastSeq 20.
	assert.equal(applyChanges(thread(), changes([m(msg(21)), m(msg(22))], 30, false)).gapFrom, null);
});

test('the higher changeSeq wins; an edit to an older row outside the ranges updates the cache only', () => {
	const edited = msg(18, { changeSeq: 30, body: 'edited', revision: 2, editedAt: 'x' });
	const s = applyChanges(thread(), changes([m(edited)], 20)).state;
	assert.equal(streamRows(s).find((r) => r.seq === 18)?.body, 'edited');
	const replay = applyChanges(s, changes([m(msg(18, { changeSeq: 18 }))], 20)).state;
	assert.equal(streamRows(replay).find((r) => r.seq === 18)?.body, 'edited', 'an older change never wins');
	const old = applyChanges(s, changes([m(msg(3, { changeSeq: 31, body: 'old edit', revision: 2 }))], 20)).state;
	assert.ok(old.messages.has(id(3)));
	assert.deepEqual(seqs(old), [16, 17, 18, 19, 20], 'no isolated stream row');
});

test('a revision change asks for the detail again; a live pin with an unknown message asks for pins', () => {
	const r = applyChanges(thread(), changes([], 20, true, 20, 2));
	assert.equal(r.refetchDetail, true);
	assert.equal(r.state.revision, 2);
	const pinOld = applyChanges(thread(), changes([p(pinOf('p1', 3, 21))], 20));
	assert.equal(pinOld.refetchPins, true);
	assert.equal(applyChanges(thread(), changes([p(pinOf('p2', 17, 21))], 20)).refetchPins, false);
});

test('a hydrated pin message is shown in pins, never as a stream row; a pin on a deleted message is hidden', () => {
	const s = initialState(messagesPage(range(16, 20), 20, true), { latest: 5 }, pinsPage([{ pin: pinOf('p1', 3, 12), message: msg(3) }], 20));
	assert.deepEqual(livePins(s).map((x) => [x.id, x.message.seq]), [['p1', 3]]);
	assert.deepEqual(seqs(s), [16, 17, 18, 19, 20]);
	const deleted = applyChanges(s, changes([m(msg(3, { changeSeq: 21, body: null, deletedAt: 'x', revision: 2 }))], 20)).state;
	assert.deepEqual(livePins(deleted), []);
});

test('applyPins never resurrects a feed-seen unpin, ignores an older snapshot, and ends pins a newer one omits', () => {
	let s = initialState(messagesPage(range(16, 20), 20, true, 20), { latest: 5 }, pinsPage([{ pin: pinOf('p1', 17, 18), message: msg(17) }], 20));
	s = applyChanges(s, changes([p(pinOf('p1', 17, 21, { unpinnedAt: 'x', unpinnedBy: 'u' }))], 20)).state;
	assert.deepEqual(livePins(s), []);
	// A snapshot taken before the unpin but applied after it still lists p1 as live at changeSeq 18.
	const stale = applyPins(s, pinsPage([{ pin: pinOf('p1', 17, 18), message: msg(17) }], 20));
	assert.deepEqual(livePins(stale), [], 'not resurrected');
	const older = applyPins({ ...s, pinsWatermark: 25 }, pinsPage([{ pin: pinOf('p9', 16, 19), message: msg(16) }], 19));
	assert.deepEqual(livePins(older), [], 'a page older than the watermark changes nothing');
	// A newer snapshot without a live pin ends it, and an older feed replay cannot make it live again.
	let t = initialState(messagesPage(range(16, 20), 20, true, 20), { latest: 5 }, pinsPage([{ pin: pinOf('p2', 18, 19), message: msg(18) }], 20));
	t = applyPins(t, pinsPage([], 26));
	assert.deepEqual(livePins(t), []);
	t = applyChanges(t, changes([p(pinOf('p2', 18, 19))], 20)).state;
	assert.deepEqual(livePins(t), []);
	// A pin newer than the snapshot is kept.
	let u = applyChanges(thread(), changes([p(pinOf('p3', 19, 30))], 20, true, 30)).state;
	u = applyPins(u, pinsPage([], 26));
	assert.deepEqual(livePins(u).map((x) => x.id), ['p3']);
});

test('reconcileIntent: done, not done or gone, comparing normalised edit bodies', () => {
	const edit = { messageId: id(5), seq: 5, kind: 'edit' as const, fromRevision: 1, body: 'Thursday at 9' };
	const page = (row: Message | null) => messagesPage(row ? [row] : [], 20, true);
	assert.equal(reconcileIntent(edit, page(msg(5, { revision: 2, body: 'Thursday at 9' }))), 'done');
	assert.equal(reconcileIntent(edit, page(msg(5, { revision: 1 }))), 'not-done');
	assert.equal(reconcileIntent(edit, page(msg(5, { revision: 3, body: 'someone else’s edit' }))), 'not-done');
	assert.equal(reconcileIntent(edit, page(msg(5, { revision: 2, body: null, deletedAt: 'x' }))), 'gone');
	assert.equal(reconcileIntent(edit, page(null)), 'gone');
	const del = { messageId: id(5), seq: 5, kind: 'delete' as const, fromRevision: 1 };
	assert.equal(reconcileIntent(del, page(msg(5, { deletedAt: 'x', body: null, revision: 2 }))), 'done');
	assert.equal(reconcileIntent(del, page(msg(5))), 'not-done');
	assert.equal(reconcileIntent(del, page(msg(6))), 'gone');
});

test('the read position only counts displayed messages inside the loaded stream', () => {
	const s = thread();
	assert.equal(highestDisplayed([16, 19, 18], s), 19);
	assert.equal(highestDisplayed([3, 25], s), 0);
	assert.equal(highestDisplayed([], s), 0);
});

test('a page whose snapshot knows messages beyond the tail opens a gap instead of claiming current', () => {
	const caughtUp = applyChanges(thread(), changes([], 20, true, 20)).state;
	assert.equal(caughtUp.current, true);
	// "Earlier messages" read after two new messages were sent, before the next changes page.
	const earlier = applyMessages(caughtUp, messagesPage(range(11, 15), 22, true), { before: 16, limit: 5 });
	assert.deepEqual(earlier.ranges, [{ from: 11, to: 20 }]);
	assert.equal(earlier.lastSeq, 22);
	assert.equal(earlier.gapFrom, 21);
	assert.equal(earlier.current, false);
	// The thread's gap load covers it and the thread is current again.
	const filled = applyMessages(earlier, messagesPage(range(21, 22), 22, false), { after: 20, limit: 50 });
	assert.equal(filled.gapFrom, null);
	assert.equal(filled.current, true);
	// The same holds for a reconciliation re-read.
	const reread = upsertMessages(caughtUp, messagesPage([msg(18, { changeSeq: 25, revision: 2, body: 'edited' })], 21, true));
	assert.equal(reread.gapFrom, 21);
	assert.equal(reread.current, false);
});

test('a reconciliation re-read updates the cache without adding a stream range', () => {
	const s = applyChanges(thread(), changes([], 20, true, 20)).state;
	const old = upsertMessages(s, messagesPage([msg(3, { changeSeq: 26, revision: 2, body: 'edited' })], 20, true));
	assert.deepEqual(old.ranges, [{ from: 16, to: 20 }]);
	assert.deepEqual(seqs(old), [16, 17, 18, 19, 20], 'no isolated row for seq 3');
	assert.equal(old.messages.get(id(3))?.body, 'edited');
	assert.equal(old.current, true);
	const inRange = upsertMessages(s, messagesPage([msg(18, { changeSeq: 26, revision: 2, body: 'edited' })], 20, true));
	assert.equal(streamRows(inRange).find((r) => r.seq === 18)?.body, 'edited');
	// Compare: applyMessages with the same one-row window would add {3, 3}.
	assert.deepEqual(applyMessages(s, messagesPage([msg(3)], 20, true), { after: 2, limit: 1 }).ranges, [{ from: 3, to: 3 }, { from: 16, to: 20 }]);
});

test('an empty conversation grows from its first message', () => {
	const s = initialState(messagesPage([], 0, false, 0), { latest: 50 }, pinsPage([], 0));
	const { state, gapFrom } = applyChanges(s, changes([m(msg(1)), m(msg(2))], 2));
	assert.equal(gapFrom, null);
	assert.deepEqual(seqs(state), [1, 2]);
	assert.equal(state.current, true);
});
