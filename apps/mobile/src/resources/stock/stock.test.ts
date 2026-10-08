import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReadScope } from '../../account/contracts.ts';
import type { Result, ThreadCalls } from '../../threads/api.ts';
import type { WebStorage } from '../../threads/storage.ts';
import { countWords, detailChanges, detailsForm, groupByLocation, itemProblem, lastCountWords, parseStockCard, parseStockItem, parseStockList, parseStocktake, parseStockWrite, stockWrites, type StockItem } from './stock.ts';
import { createStocktake, createStocktakeStorage, stocktakeCopy, stocktakeFlash, stocktakeLines } from './stocktake.ts';

// H3 S-B (docs/plans/stock-2026-10.md §3, §4): the stock parsers, grouping, the forms and the persisted stocktake draft.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope: ReadScope = { epoch: 'e1', userId: id(1), organisationId: id(2) };
const at = '2026-09-28T00:10:00.000Z';
const row = (n: number, x: Record<string, unknown> = {}) => ({ id: id(n), organisationId: id(2), name: `Item ${n}`, location: 'Cool room', unitLabel: 'bags', currentCount: '11', countedAt: at, countedBy: id(42),
	reorderPoint: null, preferredSupplierId: null, notes: '', archivedAt: null, createdAt: at, updatedAt: at, revision: 2, countedByName: 'Tom Reilly', supplierName: null, belowReorder: null, ...x });
const list = (rows: unknown[], x: Record<string, unknown> = {}) => ({ items: rows, locations: ['Cool room', 'Packaging store'], suppliers: [], timezone: 'Australia/Sydney', ...x });

test('strict parsers: a list row, a card, a write and a stocktake answer; anything unexpected refuses the answer', () => {
	const item = parseStockItem(row(10), true);
	assert.deepEqual([item.name, item.currentCount, item.countedByName, item.revision], ['Item 10', '11', 'Tom Reilly', 2]);
	for (const bad of [{ extra: 1 }, { currentCount: '-1' }, { currentCount: '1e3' }, { currentCount: 11 }, { revision: 0 }, { name: ' ' }, { countedAt: null }, { id: 'not-a-uuid' }, { belowReorder: 'no' }])
		assert.throws(() => parseStockItem(row(10, bad), true), JSON.stringify(bad));
	assert.throws(() => parseStockItem(row(10), false), 'a write row has no listed fields');
	const parsed = parseStockList(list([row(10), row(11, { currentCount: null, countedAt: null, countedBy: null, countedByName: null })]), false);
	assert.equal(parsed.items.length, 2); assert.deepEqual(parsed.locations, ['Cool room', 'Packaging store']);
	assert.throws(() => parseStockList(list([row(10), row(10)]), false), 'duplicate ids');
	assert.throws(() => parseStockList(list([row(10, { archivedAt: at })]), false), 'an archived row in the active list');
	assert.equal(parseStockList(list([row(10, { archivedAt: at })]), true).items.length, 1);
	assert.throws(() => parseStockList({ ...list([]), locations: ['Cool room', 'Cool room'] }, false));
	const counts = [3, 2, 1].map((n) => ({ id: id(100 + n), itemId: id(10), count: String(n), note: '', countedAt: `2026-09-2${n}T00:00:00.000Z`, countedBy: id(42), countedByName: 'Tom Reilly' }));
	const card = parseStockCard({ item: row(10), counts, locations: ['Cool room'], timezone: 'UTC' }, id(10));
	assert.deepEqual(card.counts.map((c) => c.count), ['3', '2', '1']);
	assert.throws(() => parseStockCard({ item: row(10), counts, locations: [], timezone: 'UTC' }, id(11)), 'another item');
	assert.throws(() => parseStockCard({ item: row(10), counts: [...counts].reverse(), locations: [], timezone: 'UTC' }, id(10)), 'newest first');
	assert.throws(() => parseStockCard({ item: row(10), counts: [...counts, { ...counts[0]!, id: id(200) }], locations: [], timezone: 'UTC' }, id(10)), 'at most three');
	assert.throws(() => parseStockCard({ item: row(10), counts: [], locations: [], timezone: 'UTC' }, id(10)), 'a counted item has counts');
	const { countedByName: _a, supplierName: _b, belowReorder: _c, ...plain } = row(12);
	assert.equal(parseStockWrite({ ...plain, changeSetId: id(900) }, { changeSetId: id(900) }).id, id(12));
	assert.throws(() => parseStockWrite({ ...plain, changeSetId: id(901) }, { changeSetId: id(900) }), 'another change set');
	assert.throws(() => parseStockWrite({ ...plain, changeSetId: id(900) }, { id: id(13), changeSetId: id(900) }), 'another item');
	assert.throws(() => parseStockWrite({ ...plain, changeSetId: id(900) }, { changeSetId: id(900), archived: true }), 'not archived');
	const taken = parseStocktake({ changeSetId: id(900), items: [row(10), row(11)] }, { changeSetId: id(900), itemIds: [id(10), id(11)] });
	assert.equal(taken.items.length, 2);
	assert.throws(() => parseStocktake({ changeSetId: id(900), items: [row(10)] }, { changeSetId: id(900), itemIds: [id(10), id(11)] }), 'every counted item');
	assert.throws(() => parseStocktake({ changeSetId: id(900), items: [row(10), row(12)] }, { changeSetId: id(900), itemIds: [id(10), id(11)] }), 'only counted items');
	assert.throws(() => parseStocktake({ changeSetId: id(900), items: [row(10, { currentCount: null, countedAt: null, countedBy: null })] }, { changeSetId: id(900), itemIds: [id(10)] }), 'with a count');
});

test('grouping by location in the list’s order; board 12’s words; the forms send only what changed and refuse what the API would', () => {
	const items = [row(1, { name: 'Wheat malt' }), row(2, { name: 'Pale malt' }), row(3, { name: 'Pallet wrap', location: 'Packaging store' }), row(4, { name: 'citra hops', location: 'cool room' })].map((r) => parseStockItem(r, true));
	const groups = groupByLocation(items);
	assert.deepEqual(groups.map((g) => [g.location, g.items.map((i) => i.name)]), [['Cool room', ['Pale malt', 'Wheat malt']], ['cool room', ['citra hops']], ['Packaging store', ['Pallet wrap']]]);
	assert.equal(countWords('4200'), '4,200'); assert.equal(countWords('1234567.125'), '1,234,567.125'); assert.equal(countWords('999999999999999999.5'), '999,999,999,999,999,999.5');
	assert.equal(lastCountWords(items[0]!, 'Australia/Sydney', 2026), '11 bags · counted Mon 28 Sep by Tom');
	assert.equal(lastCountWords({ currentCount: null, countedAt: null, countedByName: null, unitLabel: 'kg' }), 'Not counted yet');
	const item = items[0]!;
	assert.equal(detailChanges(item, detailsForm(item)), null);
	assert.deepEqual(detailChanges(item, { ...detailsForm(item), name: ' Wheat malt (crushed) ', reorderPoint: '5', notes: 'Keep dry' }), { name: 'Wheat malt (crushed)', reorderPoint: '5', notes: 'Keep dry' });
	const reorder = parseStockItem(row(5, { reorderPoint: '5.50' }), true);
	assert.equal(detailChanges(reorder, { ...detailsForm(reorder), reorderPoint: '5.5' }), null, 'the same decimal');
	assert.deepEqual(detailChanges(reorder, { ...detailsForm(reorder), reorderPoint: '' }), { reorderPoint: null }, 'cleared');
	const form = { name: 'Citra hops', location: 'Cool room', unitLabel: 'kg', reorderPoint: '', notes: '' };
	assert.equal(itemProblem(form), null);
	for (const [bad, words] of [[{ name: '' }, /name/], [{ location: ' ' }, /where it is kept/], [{ unitLabel: '' }, /unit/], [{ reorderPoint: '-1' }, /reorder point/], [{ reorderPoint: 'x' }, /reorder point/], [{ name: 'x'.repeat(201) }, /200/]] as const)
		assert.match(itemProblem({ ...form, ...bad })!, words);
	assert.deepEqual(stockWrites.add(scope, id(900), { ...form, reorderPoint: ' 2 ', notes: ' ' }).body, { changeSetId: id(900), name: 'Citra hops', location: 'Cool room', unitLabel: 'kg', reorderPoint: '2' });
	assert.deepEqual(stockWrites.archive(scope, item, id(901), true).body, { changeSetId: id(901), expectedRevision: 2, archived: true });
	assert.deepEqual(stockWrites.edit(scope, item, id(902), { notes: 'Dry' }).body, { changeSetId: id(902), expectedRevision: 2, notes: 'Dry' });
	const lines = stocktakeLines(items, { [id(1)]: ' 12 ', [id(2)]: '', [id(3)]: '1,5', [id(99)]: '4' });
	assert.deepEqual(lines.lines, [{ itemId: id(1), expectedRevision: 2, count: '12' }], 'filled rows of listed items only');
	assert.deepEqual(Object.keys(lines.problems), [id(3)]); assert.equal(lines.counted, 2);
});

function memory(): WebStorage & { map: Map<string, string> } {
	const map = new Map<string, string>();
	return { map, get length() { return map.size; }, key: (i: number) => [...map.keys()][i] ?? null, getItem: (k: string) => map.get(k) ?? null,
		setItem: (k: string, v: string) => { map.set(k, v); }, removeItem: (k: string) => { map.delete(k); } };
}
test('the persisted draft is this person’s and organisation’s, validated strictly, and cleared for another person or on sign-out', () => {
	const store = memory(), storage = createStocktakeStorage(() => store);
	const other: ReadScope = { epoch: 'e2', userId: id(3), organisationId: id(2) };
	assert.ok(storage.save(scope, { values: { [id(10)]: '12' }, pending: null }));
	assert.deepEqual(storage.load(scope), { values: { [id(10)]: '12' }, pending: null });
	assert.equal(storage.load(other), null, 'another person sees nothing');
	assert.equal(storage.load({ ...scope, organisationId: id(5) }), null, 'another organisation sees nothing');
	storage.save(scope, { values: { [id(10)]: '' }, pending: null }); assert.equal(store.map.size, 0, 'nothing typed, nothing kept');
	for (const raw of ['{', '[]', JSON.stringify({ values: {} }), JSON.stringify({ values: { nope: '1' }, pending: null }), JSON.stringify({ values: { [id(10)]: 12 }, pending: null }),
		JSON.stringify({ values: {}, pending: { changeSetId: id(900), counts: [] } }), JSON.stringify({ values: {}, pending: { changeSetId: id(900), counts: [{ itemId: id(10), expectedRevision: 1, count: '-1' }] } }),
		JSON.stringify({ values: {}, pending: { changeSetId: id(900), counts: [{ itemId: id(10), expectedRevision: 1, count: '1' }, { itemId: id(10), expectedRevision: 1, count: '2' }] } })]) {
		store.map.set(`captain.stocktake.${scope.userId}.${scope.organisationId}`, raw);
		assert.equal(storage.load(scope), null, raw); assert.equal(store.map.size, 0, 'an invalid draft is removed');
	}
	storage.save(scope, { values: { [id(10)]: '1' }, pending: null }); storage.save(other, { values: { [id(10)]: '2' }, pending: null }); store.map.set('captain.other', 'kept');
	storage.person(scope.userId); assert.deepEqual([...store.map.keys()].sort(), ['captain.other', `captain.stocktake.${scope.userId}.${scope.organisationId}`]);
	storage.person(null); assert.deepEqual([...store.map.keys()], ['captain.other'], 'sign-out clears every stocktake');
	const failing = createStocktakeStorage(() => { throw new Error('blocked'); });
	assert.equal(failing.save(scope, { values: { [id(10)]: '1' }, pending: null }), false); assert.equal(failing.load(scope), null);
});

type Answer = Result<unknown> | { value: unknown };
function controller(answers: Answer[], store = memory()) {
	let now = 0, n = 0, live = true; const sent: { method: string; path: string; body: unknown }[] = [];
	const calls = {
		current: () => live,
		async request<T>(_s: ReadScope, method: string, path: string, body: unknown, parse: (v: unknown) => T): Promise<Result<T>> {
			sent.push({ method, path, body });
			const a = answers.shift(); if (!a) throw new Error(`no answer for ${method} ${path}`);
			if ('value' in a && !('kind' in a)) return { kind: 'ok', value: parse(a.value) };
			return a as Result<T>;
		}
	} as unknown as ThreadCalls;
	const storage = createStocktakeStorage(() => store);
	const make = () => createStocktake({ calls, scope, now: () => now, randomId: () => id(900 + ++n), storage });
	return { c: make(), make, sent, store, storage, tick: (ms: number) => { now += ms; }, leave: () => { live = false; } };
}
const items3 = [row(10, { name: 'Pale malt' }), row(11, { name: 'Wheat malt' }), row(12, { name: 'Citra hops', unitLabel: 'kg', currentCount: null, countedAt: null, countedBy: null, countedByName: null })];
const unknown: Result<unknown> = { kind: 'error', status: 503, code: 'unavailable', retryAfter: 0, uncertain: true };
const counted = (ids: number[], cs: number) => ({ value: { changeSetId: id(cs), items: ids.map((i) => row(i, { currentCount: '5', revision: 3 })) } });

test('a stocktake: type two, skip one, save once with the filled rows; success clears the draft and says what was saved', async () => {
	const h = controller([{ value: list(items3) }, counted([10, 12], 901)]);
	await h.c.load(); assert.equal(h.c.snapshot().phase, 'ready');
	h.c.type(id(10), '12'); h.c.type(id(12), '2.5');
	assert.ok(h.storage.load(scope)?.values[id(10)] === '12', 'typed counts persist as they are typed');
	await h.c.save();
	assert.deepEqual(h.sent[1], { method: 'POST', path: `/v1/organisations/${id(2)}/stock/stocktake`, body: { changeSetId: id(901), counts: [
		{ itemId: id(10), expectedRevision: 2, count: '12' }, { itemId: id(12), expectedRevision: 2, count: '2.5' }] } });
	assert.equal(h.c.snapshot().saved, 2); assert.equal(h.c.snapshot().message, stocktakeCopy.saved(2));
	assert.equal(h.storage.load(scope), null, 'cleared on save'); assert.deepEqual(h.c.snapshot().values, {});
	const empty = controller([{ value: list(items3) }]); await empty.c.load(); await empty.c.save();
	assert.equal(empty.sent.length, 1, 'nothing typed, nothing sent'); assert.equal(empty.c.snapshot().message, stocktakeCopy.nothing);
	empty.c.type(id(10), 'abc'); await empty.c.save(); assert.equal(empty.sent.length, 1, 'an invalid count is never sent'); assert.equal(empty.c.snapshot().message, stocktakeCopy.invalid);
});

test('an uncertain save keeps its id and body across leaving the screen, for an explicit retry with the same id', async () => {
	const h = controller([{ value: list(items3) }, unknown]);
	await h.c.load(); h.c.type(id(10), '12'); await h.c.save();
	const first = h.c.snapshot();
	assert.equal(first.uncertain, true); assert.equal(first.message, stocktakeCopy.unknown);
	h.c.type(id(11), '3'); assert.equal(h.c.snapshot().values[id(11)], undefined, 'the form is locked while uncertain');
	await h.c.save(); assert.equal(h.sent.length, 2, 'never retried by itself, nor by a new save');
	// Leaving and coming back: a new screen restores the uncertain save, locked, with the same id and body.
	h.c.dispose();
	const again = controller([{ value: list(items3) }, counted([10], 901)], h.store);
	assert.equal(again.c.snapshot().uncertain, true); assert.deepEqual(again.c.snapshot().pending, first.pending);
	await again.c.load(); await again.c.retry();
	assert.deepEqual(again.sent[1]!.body, h.sent[1]!.body, 'the same id and the same body');
	assert.equal(again.c.snapshot().saved, 1); assert.equal(again.storage.load(scope), null);
	// Discard drops the id and reloads; the typed counts stay for the person to check.
	const d = controller([{ value: list(items3) }, unknown, { value: list(items3) }, { value: list(items3) }]);
	await d.c.load(); d.c.type(id(10), '12'); await d.c.save(); d.c.discard(); await d.c.load();
	assert.deepEqual([d.c.snapshot().uncertain, d.c.snapshot().pending, d.c.snapshot().message], [false, null, stocktakeCopy.discarded]);
	assert.equal(d.c.snapshot().values[id(10)], '12');
});

test('a stale refusal reloads, marks those rows and clears their counts, keeps the rest typed, and the next save takes a new id', async () => {
	const stale: Result<unknown> = { kind: 'error', status: 409, code: 'stale_revision', retryAfter: 0, uncertain: false, detail: { itemIds: [id(11), id(99)] } };
	const h = controller([{ value: list(items3) }, stale, { value: list([items3[0], row(11, { name: 'Wheat malt', currentCount: '7', revision: 3, countedByName: 'Maya Chen' }), items3[2]]) }, counted([10, 11], 902)]);
	await h.c.load(); h.c.type(id(10), '12'); h.c.type(id(11), '4'); await h.c.save();
	const s = h.c.snapshot();
	assert.deepEqual([s.stale, s.values, s.message, s.pending], [[id(11)], { [id(10)]: '12' }, stocktakeCopy.stale, null]);
	assert.equal(s.list!.items.find((i) => i.id === id(11))!.currentCount, '7', 'reloaded');
	h.c.type(id(11), '5'); assert.deepEqual(h.c.snapshot().stale, [], 'typing again clears the mark');
	await h.c.save();
	const body = h.sent[3]!.body as { changeSetId: string; counts: { expectedRevision: number }[] };
	assert.equal(body.changeSetId, id(902), 'a new id'); assert.deepEqual(body.counts.map((c) => c.expectedRevision), [2, 3], 'the reloaded revision');
	// An archived item drops out the same way.
	const archived: Result<unknown> = { kind: 'error', status: 400, code: 'stock_archived', retryAfter: 0, uncertain: false, detail: { itemIds: [id(12)] } };
	const a = controller([{ value: list(items3) }, archived, { value: list(items3.slice(0, 2)) }]);
	await a.c.load(); a.c.type(id(10), '1'); a.c.type(id(12), '2'); await a.c.save();
	assert.deepEqual([a.c.snapshot().values, a.c.snapshot().message, a.c.snapshot().list!.items.length], [{ [id(10)]: '1' }, stocktakeCopy.archived, 2]);
});

test('429 keeps the form with its wait and the unused id; a refused id is not reused; lost access; a stale scope writes nothing', async () => {
	const h = controller([{ value: list(items3) }, { kind: 'error', status: 429, code: 'unavailable', retryAfter: 30, uncertain: false }, counted([10], 901)]);
	await h.c.load(); h.c.type(id(10), '12'); await h.c.save();
	assert.deepEqual([h.c.snapshot().message, h.c.snapshot().uncertain], [stocktakeCopy.rate, false]);
	h.c.type(id(10), '13'); assert.equal(h.c.snapshot().values[id(10)], '13', 'still editable');
	await h.c.save(); assert.equal(h.sent.length, 2, 'refused during the wait');
	h.tick(30_000); await h.c.save(); assert.equal((h.sent[2]!.body as { changeSetId: string }).changeSetId, id(901), 'the unused id is kept');
	const r = controller([{ value: list(items3) }, { kind: 'error', status: 409, code: 'change_set_id_unavailable', retryAfter: 0, uncertain: false }, counted([10], 902)]);
	await r.c.load(); r.c.type(id(10), '1'); await r.c.save(); assert.equal(r.c.snapshot().message, stocktakeCopy.idUnavailable);
	await r.c.save(); assert.notEqual((r.sent[2]!.body as { changeSetId: string }).changeSetId, (r.sent[1]!.body as { changeSetId: string }).changeSetId);
	const l = controller([{ value: list(items3) }, { kind: 'error', status: 404, code: 'not_found', retryAfter: 0, uncertain: false }]);
	await l.c.load(); l.c.type(id(10), '1'); await l.c.save(); assert.equal(l.c.snapshot().phase, 'lost'); assert.equal(l.storage.load(scope), null);
	const gone = controller([{ value: list(items3) }]); await gone.c.load(); gone.leave(); gone.c.type(id(10), '1');
	assert.deepEqual(gone.c.snapshot().values, {}, 'nothing changes once the scope is gone');
	// Cancel forgets the typed counts.
	const c = controller([{ value: list(items3) }]); await c.c.load(); c.c.type(id(10), '1'); c.c.cancel();
	assert.deepEqual(c.c.snapshot().values, {}); assert.equal(c.storage.load(scope), null);
	// The list's line after a save is this scope's, once.
	stocktakeFlash.set(scope, 'Saved'); assert.equal(stocktakeFlash.take({ ...scope, epoch: 'other' }), null); stocktakeFlash.set(scope, 'Saved');
	assert.equal(stocktakeFlash.take(scope), 'Saved'); assert.equal(stocktakeFlash.take(scope), null);
});

test('a reload drops typed counts for items no longer listed; a failed first load says so', async () => {
	const h = controller([{ value: list(items3) }, { value: list(items3.slice(0, 1)) }]);
	await h.c.load(); h.c.type(id(10), '1'); h.c.type(id(11), '2'); await h.c.load();
	assert.deepEqual(h.c.snapshot().values, { [id(10)]: '1' });
	const f = controller([{ kind: 'error', status: 503, code: 'unavailable', retryAfter: 0, uncertain: false }]);
	await f.c.load(); assert.deepEqual([f.c.snapshot().phase, f.c.snapshot().message], ['failed', stocktakeCopy.failed]);
	const w = controller([{ kind: 'error', status: 429, code: 'unavailable', retryAfter: 9, uncertain: false }]);
	await w.c.load(); assert.equal(w.c.snapshot().message, stocktakeCopy.wait);
	void (null as unknown as StockItem);
});
