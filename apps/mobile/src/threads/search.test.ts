import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ThreadCalls, Result } from './api.ts';
import { createSearch, excerptParts, parseSearch, resultsWords, searchCopy, searchDelay, searchText } from './search.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = { epoch: 'one', userId: id(1), organisationId: id(2) };
const row = (n: number, match: unknown = { kind: 'message', excerpt: 'Book the «canning» line', authorName: 'Olive Ng' }) => ({ id: id(n), kind: 'topic', title: `Topic ${n}`, record: null, facts: ['Olive Ng', ''],
	status: null, lastMessageAt: '2026-10-08T01:00:00.000Z', lastMessage: { authorName: 'Olive Ng', excerpt: 'Book the canning line' }, unread: 0, needsYou: false, starred: false, tags: [], match });

test('a search answer is read strictly: the words and filter asked, the list’s row shape and a match', () => {
	const answer = { filter: 'tasks', q: 'canning', available: true, threads: [row(10), row(11, { kind: 'title', excerpt: '«Canning» line service', authorName: null })] };
	const parsed = parseSearch(answer, { filter: 'tasks', q: 'canning' });
	assert.deepEqual(parsed.threads.map((r) => [r.id, r.match.kind]), [[id(10), 'message'], [id(11), 'title']]);
	for (const bad of [{ ...answer, q: 'other' }, { ...answer, filter: 'all' }, { ...answer, groups: [] }, { ...answer, nextCursor: null }, { ...answer, threads: [row(10), row(10)] },
		{ ...answer, threads: [{ ...row(10), match: undefined }] }, { ...answer, threads: [row(10, { kind: 'title', excerpt: 'x', authorName: 'Olive' })] },
		{ ...answer, threads: [row(10, { kind: 'body', excerpt: 'x', authorName: null })] }, { ...answer, threads: [{ ...row(10), extra: 1 }] },
		{ ...answer, available: false }, { ...answer, threads: Array.from({ length: 51 }, (_, i) => row(100 + i)) }])
		assert.throws(() => parseSearch(bad, { filter: 'tasks', q: 'canning' }), TypeError, JSON.stringify(bad).slice(0, 80));
	assert.deepEqual(parseSearch({ filter: 'files', q: 'ab', available: false, threads: [] }, { filter: 'files', q: 'ab' }).threads, []);
});

test('excerpt marks become emphasis; an unpaired mark is shown as written; counts are worded', () => {
	assert.deepEqual(excerptParts('Book the «canning» line, «canning» day'), [{ text: 'Book the ', mark: false }, { text: 'canning', mark: true }, { text: ' line, ', mark: false }, { text: 'canning', mark: true }, { text: ' day', mark: false }]);
	assert.deepEqual(excerptParts('«Label» «printing»'), [{ text: 'Label', mark: true }, { text: ' ', mark: false }, { text: 'printing', mark: true }]);
	assert.deepEqual(excerptParts('no marks'), [{ text: 'no marks', mark: false }]);
	assert.deepEqual(excerptParts('half «open'), [{ text: 'half «open', mark: false }]);
	assert.deepEqual(excerptParts('closed» only'), [{ text: 'closed» only', mark: false }]);
	assert.deepEqual([resultsWords(1), resultsWords(12)], ['1 result', '12 results']);
	assert.deepEqual([searchText(' a '), searchText(' ab '), searchText('🍺🍺'), searchText('x'.repeat(201))], [null, 'ab', '🍺🍺', null]);
});

function harness(answers: Result<unknown>[]) {
	let now = 0; const timers: { at: number; fn: () => void; handle: number }[] = []; let handles = 0; const sent: string[] = [];
	const calls = { current: () => true, request: async (_s: unknown, _m: string, path: string, _b: unknown, parse: (v: unknown) => unknown) => {
		sent.push(path); const a = answers.shift()!; if (a.kind !== 'ok') return a; return { kind: 'ok', value: parse(a.value) };
	} } as unknown as ThreadCalls;
	const search = createSearch(calls, scope, { now: () => now, set: (fn, ms) => { const handle = ++handles; timers.push({ at: now + ms, fn, handle }); return handle; },
		clear: (h) => { const i = timers.findIndex((t) => t.handle === h); if (i >= 0) timers.splice(i, 1); } });
	const advance = async (ms: number) => { now += ms; for (const t of timers.filter((t) => t.at <= now)) { timers.splice(timers.indexOf(t), 1); t.fn(); } await new Promise((r) => setTimeout(r, 0)); };
	return { search, sent, advance, pending: () => timers.length };
}
const answer = (q: string, n = 1, filter = 'all') => ({ kind: 'ok' as const, value: { filter, q, available: true, threads: Array.from({ length: n }, (_, i) => row(20 + i)) } });

test('typing is debounced: one search after the pause, for the latest words; under 2 characters the list stays', async () => {
	const h = harness([answer('cann', 2)]);
	h.search.open(); h.search.type('c');
	assert.equal(h.search.active(), false); assert.equal(h.pending(), 0, 'one character schedules nothing');
	h.search.type('ca'); await h.advance(searchDelay - 1); h.search.type('can'); await h.advance(searchDelay - 1); h.search.type('cann');
	assert.equal(h.sent.length, 0, 'nothing sent while typing');
	assert.equal(h.search.snapshot().phase, 'waiting'); assert.equal(h.search.active(), true, 'the list’s polling pauses');
	await h.advance(searchDelay);
	assert.equal(h.sent.length, 1); assert.match(h.sent[0]!, /\/threads\?q=cann&filter=all&limit=50$/);
	assert.equal(h.search.snapshot().phase, 'ready'); assert.equal(h.search.snapshot().result!.threads.length, 2);
	h.search.type('c'); assert.equal(h.search.active(), false); assert.equal(h.search.snapshot().result, null, 'back to the list');
	h.search.close(); assert.deepEqual([h.search.snapshot().open, h.search.snapshot().text], [false, '']);
});

test('an answer for older words is dropped; a filter change searches again; a failure says so and waits on 429', async () => {
	const slow: Result<unknown>[] = [answer('old'), answer('new', 3, 'tasks'), { kind: 'error', status: 429, code: 'rate_limited', retryAfter: 4, uncertain: false }, { kind: 'error', status: 503, code: 'unavailable', retryAfter: 0, uncertain: false }];
	const h = harness(slow);
	h.search.open(); h.search.type('old'); await h.advance(searchDelay);
	h.search.filter('tasks'); h.search.type('new'); await h.advance(searchDelay);
	assert.equal(h.search.snapshot().q, 'new'); assert.equal(h.search.snapshot().result!.filter, 'tasks');
	assert.match(h.sent[1]!, /filter=tasks/);
	h.search.type('newer'); await h.advance(searchDelay);
	assert.equal(h.search.snapshot().phase, 'failed'); assert.equal(h.search.snapshot().message, searchCopy.wait);
	h.search.retry(); assert.equal(h.sent.length, 3, 'no retry inside the wait');
	await h.advance(4000); h.search.retry(); await h.advance(0);
	assert.equal(h.sent.length, 4); assert.equal(h.search.snapshot().message, searchCopy.failed);
});
