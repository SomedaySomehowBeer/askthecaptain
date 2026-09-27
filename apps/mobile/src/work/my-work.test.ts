import assert from 'node:assert/strict';
import { test } from 'node:test';
import { displayTitle, formatDue, parseMyWorkPage, parseWorkPage } from './my-work.ts';

const scope = { userId: '0190c0de-0000-7000-8000-000000000001', organisationId: '0190c0de-0000-7000-8000-000000000002' };
const request = { scope, offset: 0 };
const id = (n: number) => `0190c0de-0000-7000-8000-${String(n).padStart(12, '0')}`;
const tag = (n: number) => ({ id: id(n), name: `Tag ${n}`, ignored: 'private extra' });
const task = (n = 10) => ({ id: id(n), title: '  Synthetic sample task  ', status: 'open', ownerId: scope.userId, due: '2026-10-03', tags: [tag(1)], ignored: 'private extra' });
const page = (tasks: unknown[], nextOffset: unknown = null) => ({ tasks, nextOffset, ignored: 'private extra' });
const parse = (value: unknown) => parseMyWorkPage(value, request);
const refuses = (value: unknown) => assert.throws(() => parse(value), { name: 'TypeError', message: 'The work page could not be read.' });

test('a work page retains only new frozen display objects and ignores unknown fields', () => {
	const input = task(); const result = parse(page([input])); const row = result.rows[0]!;
	assert.deepEqual(result, { rows: [{ id: input.id, displayTitle: 'Synthetic sample task', owner: 'you', status: 'open', due: { year: 2026, month: 10, day: 3 }, tags: [{ id: id(1), name: 'Tag 1' }], tagCount: 1 }], nextOffset: null });
	for (const value of [result, result.rows, row, row.due, row.tags, row.tags[0]]) assert.ok(Object.isFrozen(value));
	input.title = 'Changed'; input.tags[0]!.name = 'Changed';
	assert.equal(row.displayTitle, 'Synthetic sample task'); assert.equal(row.tags[0]!.name, 'Tag 1');
	assert.ok(!JSON.stringify(result).includes('private extra'));
	assert.equal(formatDue(row.due), 'Due 3 Oct 2026');
});

test('empty is a valid successful page, distinct from a missing or unreadable page', () => {
	assert.deepEqual(parse(page([])), { rows: [], nextOffset: null });
	for (const bad of [null, undefined, [], '', {}, { tasks: [] }, { nextOffset: null }, page(null as never), page({} as never), page(new Array(1))]) refuses(bad);
});

test('paging is bounded and continuation must describe exactly a full next page', () => {
	const fifty = Array.from({ length: 50 }, (_, i) => task(i + 10));
	assert.equal(parse(page(fifty, 50)).nextOffset, 50);
	assert.equal(parse(page(fifty)).nextOffset, null);
	assert.equal(parseMyWorkPage(page(fifty, 500), { scope, offset: 450 }).nextOffset, 500, 'the last permitted page may report more; the UI stops at its cap');
	for (const bad of [0, 49, 51, -50, '50', undefined, NaN, Infinity, {}]) refuses({ tasks: fifty, nextOffset: bad });
	refuses(page(fifty.slice(1), 50)); refuses(page([...fifty, task(100)]));
	assert.throws(() => parseMyWorkPage(page([]), { scope, offset: 500 }), TypeError);
});

test('identity, ownership, status and used task fields are validated; errors repeat no input', () => {
	for (const patch of [
		{ id: 'not-a-uuid' }, { id: id(10).toUpperCase() }, { ownerId: id(999) }, { ownerId: null },
		{ status: 'in_progress' }, { status: 'done' }, { status: undefined }, { title: null }, { title: 123 },
		{ tags: null }, { tags: {} }, { due: undefined }, { title: { token: 'secret-canary' } }
	]) refuses(page([{ ...task(), ...patch }]));
	for (const value of [null, 42, [], 'secret-canary']) refuses(page([value]));
	refuses(page([task(), task()]));
});

test('all valid tag counts are supported, retaining three and their actual total', () => {
	for (const count of [0, 3, 4, 150]) {
		const tags = Array.from({ length: count }, (_, i) => tag(i));
		const row = parse(page([{ ...task(), tags }])).rows[0]!;
		assert.equal(row.tagCount, count); assert.equal(row.tags.length, Math.min(count, 3));
		assert.deepEqual(row.tags, tags.slice(0, 3).map(({ id, name }) => ({ id, name })));
	}
	const emojiName = '🍺'.repeat(60);
	assert.equal(parse(page([{ ...task(), tags: [{ id: id(1), name: emojiName }] }])).rows[0]!.tags[0]!.name, emojiName);
});

test('a bad tag anywhere invalidates the page, including tags omitted from display', () => {
	for (const invalid of [null, [], { id: id(1), name: '' }, { id: id(1), name: ' spaced ' },
		{ id: 'secret-canary', name: 'Valid' }, { id: id(1), name: 4 }, { id: id(1), name: 'a'.repeat(61) }, { id: id(1), name: '🍺'.repeat(61) }]) {
		refuses(page([{ ...task(), tags: [tag(1), tag(2), tag(3), invalid] }]));
	}
	const sparse = Array.from({ length: 150 }, (_, i) => tag(i)); delete sparse[149];
	refuses(page([{ ...task(), tags: sparse }]));
});

test('plain dates validate the Gregorian calendar without timezone or Date normalization', () => {
	for (const [due, formatted] of [
		['0001-01-01', 'Due 1 Jan 1'], ['2024-02-29', 'Due 29 Feb 2024'], ['2000-02-29', 'Due 29 Feb 2000'],
		['9999-12-31', 'Due 31 Dec 9999'], ['1900-02-28', 'Due 28 Feb 1900']
	]) assert.equal(formatDue(parse(page([{ ...task(), due }])).rows[0]!.due), formatted);
	assert.equal(formatDue(parse(page([{ ...task(), due: null }])).rows[0]!.due), 'No due date');
	for (const due of ['0000-01-01', '1900-02-29', '2100-02-29', '2026-02-29', '2026-13-01', '2026-00-01',
		'2026-04-31', '2026-01-00', '2026-01-32', '10000-01-01', '0044-03-15 BC', '2026-1-1', '2026-01-01T00:00:00Z', 20260101])
		refuses(page([{ ...task(), due }]));
});

test('titles are capped only for display, including generated long titles and supplementary code points', () => {
	assert.equal(displayTitle(' \n\t'), 'Untitled task'); assert.equal(displayTitle('  Ready  '), 'Ready');
	assert.equal(displayTitle('x'.repeat(300)), 'x'.repeat(300));
	assert.equal(displayTitle('x'.repeat(301)), `${'x'.repeat(299)}…`);
	assert.equal(displayTitle('🍺'.repeat(301)), `${'🍺'.repeat(299)}…`);
	const row = parse(page([{ ...task(), title: 'x'.repeat(10_000) }])).rows[0]!;
	assert.equal(row.displayTitle.length, 300); assert.ok(!('title' in row));
	assert.equal(parse(page([{ ...task(), title: '' }])).rows[0]!.displayTitle, 'Untitled task');
});

test('All tasks maps every owner kind without retaining owner identifiers; My work remains restricted', () => {
 const input = [task(10), { ...task(11), ownerId: id(99) }, { ...task(12), ownerId: null }];
 const result = parseWorkPage(page(input), { ...request, view: 'all' });
 assert.deepEqual(result.rows.map(row => row.owner), ['you', 'someone-else', 'none']);
 for (const row of result.rows) assert.ok(!('ownerId' in row));
 assert.ok(!JSON.stringify(result).includes(id(99)));
 assert.throws(() => parseMyWorkPage(page(input), request), TypeError);
 assert.deepEqual(parseWorkPage(page([task()]), { ...request, view: 'mine' }), parse(page([task()])));
});

test('All tasks refuses missing or malformed owners, non-open statuses and malformed shared fields', () => {
 const parseAll = (value: unknown) => parseWorkPage(value, { ...request, view: 'all' });
 for (const ownerId of [undefined, '', id(99).toUpperCase(), 1, {}, 'secret-canary'])
  assert.throws(() => parseAll(page([{ ...task(), ownerId }])), TypeError);
 const { ownerId: _owner, ...withoutOwner } = task();
 assert.throws(() => parseAll(page([withoutOwner])), TypeError);
 for (const patch of [{ status: 'in_progress' }, { status: 'done' }, { due: '2026-02-29' }, { tags: null }])
  assert.throws(() => parseAll(page([{ ...task(), ...patch }])), TypeError);
 assert.throws(() => parseAll(page([task(), task()])), TypeError);
 assert.throws(() => parseWorkPage(page([]), { ...request, view: 'unknown' as never }), TypeError);
});
