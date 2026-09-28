import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	catalogueAnswer, catalogueView, createCatalogue, finishCatalogueRead, planCatalogueRead, refreshCatalogue, startCatalogueRead,
	type CatalogueAnswer, type CatalogueIntent, type CatalogueRequest, type CatalogueState
} from './catalogue.ts';
import { parseEquipmentPage, type EquipmentPage } from './data.ts';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const range = (first: number, count: number) => Array.from({ length: count }, (_, i) => first + i);
/** A catalogue page as the API sends it, through the real parser bound to its request. */
function page(offset: number, ids: readonly number[], more = false): EquipmentPage {
	const equipment = ids.map((n) => ({ id: uuid(n), name: `Kit ${n}`, archivedAt: null, revision: 1,
		createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }));
	return parseEquipmentPage({ equipment, nextOffset: more ? offset + 100 : null }, { offset, limit: 100 });
}
const ok = (value: EquipmentPage): CatalogueAnswer => ({ kind: 'page', page: value });
const down: CatalogueAnswer = { kind: 'failed', reason: 'unavailable' };
const refused: CatalogueAnswer = { kind: 'failed', reason: 'access' };
const ids = (state: CatalogueState) => state.columns.map((column) => column.id);

/** Plans and starts `intent`, asserting both succeed. */
function begin(state: CatalogueState, intent: CatalogueIntent): { state: CatalogueState; request: CatalogueRequest } {
	const request = planCatalogueRead(state, intent);
	assert.ok(request, `${intent} is planned`);
	const started = startCatalogueRead(state, request);
	assert.ok(started, `${intent} starts`);
	return { state: started, request };
}
function read(state: CatalogueState, intent: CatalogueIntent, answer: CatalogueAnswer): CatalogueState {
	const { state: started, request } = begin(state, intent);
	return finishCatalogueRead(started, request, answer);
}
/** Two full pages loaded, a third page available. */
function twoPages(): CatalogueState {
	const first = read(createCatalogue(), 'first', ok(page(0, range(1, 100), true)));
	return read(first, 'more', ok(page(100, range(101, 100), true)));
}
const noneBut = (state: CatalogueState, allowed: CatalogueIntent | null) => {
	for (const intent of ['first', 'more', 'retry', 'refresh'] as const)
		if (intent !== allowed) assert.equal(planCatalogueRead(state, intent), null, `${intent} is not the next read`);
};

test('mount reads page 0 with limit 100, once, and shows nothing until it answers', () => {
	const state = createCatalogue();
	assert.deepEqual(catalogueView(state), { status: 'loading', columns: [], stale: false, more: 'none', notices: [], tryAgain: null, access: false });
	noneBut(state, 'first');
	const request = planCatalogueRead(state, 'first')!;
	assert.deepEqual(request, { id: 1, generation: 1, intent: 'first', offset: 0, limit: 100, key: 'catalogue:1:0', retry: false });
	assert.ok(Object.isFrozen(request));
	assert.deepEqual(state, createCatalogue(), 'planning changes nothing');
	const started = startCatalogueRead(state, request)!;
	assert.equal(started.pending, request);
	noneBut(started, null);
	assert.equal(startCatalogueRead(started, request), null, 'one catalogue read at a time');
	assert.equal(catalogueView(started).status, 'loading');
});

test('columns keep the API order and are never re-sorted', () => {
	const order = [7, 3, 9, 1];
	const state = read(createCatalogue(), 'first', ok(page(0, order)));
	assert.deepEqual(ids(state), order.map(uuid));
	const view = catalogueView(state);
	assert.equal(view.status, 'listed');
	assert.deepEqual(view.columns.map((column) => column.name), ['Kit 7', 'Kit 3', 'Kit 9', 'Kit 1']);
	assert.ok(Object.isFrozen(state.columns));
	noneBut(state, null);
});

test('More is explicit, reads the next offset, appends in order, and ends at the last page', () => {
	const first = read(createCatalogue(), 'first', ok(page(0, range(1, 100), true)));
	assert.deepEqual(catalogueView(first), {
		status: 'listed', columns: first.columns, stale: false, more: 'offered', notices: ['more-not-loaded'], tryAgain: null, access: false,
	});
	noneBut(first, 'more');
	const { state: loading, request } = begin(first, 'more');
	assert.deepEqual(request, { id: 2, generation: 1, intent: 'more', offset: 100, limit: 100, key: 'catalogue:1:100', retry: false });
	assert.equal(catalogueView(loading).more, 'loading');
	assert.deepEqual(catalogueView(loading).notices, ['more-not-loaded']);
	const last = finishCatalogueRead(loading, request, ok(page(100, [300, 200])));
	assert.deepEqual(ids(last), [...range(1, 100), 300, 200].map(uuid));
	assert.equal(last.nextOffset, null);
	assert.deepEqual(catalogueView(last), { status: 'listed', columns: last.columns, stale: false, more: 'none', notices: [], tryAgain: null, access: false });
	noneBut(last, null);
});

test('only a successful empty first page is empty', () => {
	const empty = read(createCatalogue(), 'first', ok(page(0, [])));
	assert.deepEqual(catalogueView(empty), { status: 'empty', columns: [], stale: false, more: 'none', notices: [], tryAgain: null, access: false });
	assert.equal(catalogueView(createCatalogue()).status, 'loading');
	assert.equal(catalogueView(read(createCatalogue(), 'first', down)).status, 'failed');
	// An empty later page (rows removed while paging) ends the list; it doesn't make it empty.
	const shrunk = read(read(createCatalogue(), 'first', ok(page(0, range(1, 100), true))), 'more', ok(page(100, [])));
	assert.equal(catalogueView(shrunk).status, 'listed');
	assert.equal(catalogueView(shrunk).more, 'none');
});

test('an ID already shown is dropped from a later page, with the list-changed notice', () => {
	const first = read(createCatalogue(), 'first', ok(page(0, range(1, 100), true)));
	// The list shifted: 99 and 100 appear again at the start of page 1.
	const second = read(first, 'more', ok(page(100, [99, 100, ...range(101, 98)], true)));
	assert.deepEqual(ids(second), range(1, 198).map(uuid), 'each ID once, in first-seen order');
	assert.equal(second.columns.length, 198);
	assert.deepEqual(catalogueView(second).notices, ['more-not-loaded', 'list-changed']);
	assert.equal(catalogueView(second).more, 'offered', 'paging continues');
	// The notice stays until a Refresh succeeds, even when later pages are clean.
	const third = read(second, 'more', ok(page(200, [500])));
	assert.deepEqual(catalogueView(third).notices, ['list-changed']);
	const refreshed = read(refreshCatalogue(third), 'refresh', ok(page(0, [1, 2])));
	assert.deepEqual(catalogueView(refreshed).notices, []);
	// A page made only of duplicates still advances nextOffset.
	const repeat = read(first, 'more', ok(page(100, range(1, 100), true)));
	assert.equal(repeat.columns.length, 100);
	assert.equal(repeat.nextOffset, 200);
	assert.deepEqual(catalogueView(repeat).notices, ['more-not-loaded', 'list-changed']);
});

test('a failed first page fails the catalogue; Try again repeats page 0', () => {
	const failed = read(createCatalogue(), 'first', down);
	assert.deepEqual(catalogueView(failed), { status: 'failed', columns: [], stale: false, more: 'none', notices: [], tryAgain: 'catalogue', access: false });
	noneBut(failed, 'retry');
	const retry = planCatalogueRead(failed, 'retry')!;
	assert.deepEqual(retry, { id: 2, generation: 1, intent: 'retry', offset: 0, limit: 100, key: 'catalogue:1:0', retry: true });
	const again = read(failed, 'retry', down);
	assert.equal(catalogueView(again).tryAgain, 'catalogue', 'Try again can repeat');
	const loaded = read(again, 'retry', ok(page(0, [4, 5], false)));
	assert.equal(catalogueView(loaded).status, 'listed');
	assert.equal(catalogueView(loaded).tryAgain, null);
	assert.equal(loaded.failure, null);
});

test('a refused first page shows the access wording and only Refresh reads again', () => {
	const refusedState = read(createCatalogue(), 'first', refused);
	assert.deepEqual(catalogueView(refusedState), { status: 'failed', columns: [], stale: false, more: 'none', notices: [], tryAgain: null, access: true });
	noneBut(refusedState, null);
	const refreshed = refreshCatalogue(refusedState);
	noneBut(refreshed, 'refresh');
	assert.equal(catalogueView(refreshed).access, false);
	assert.equal(catalogueView(read(refreshed, 'refresh', ok(page(0, [1])))).status, 'listed');
});

test('a failed later page keeps the loaded columns, labelled incomplete, with its own Try again', () => {
	const pages = twoPages();
	const failed = read(pages, 'more', down);
	assert.deepEqual(ids(failed), ids(pages), 'the loaded columns stay');
	assert.deepEqual(catalogueView(failed), {
		status: 'listed', columns: pages.columns, stale: false, more: 'try-again', notices: ['more-not-loaded', 'incomplete'],
		tryAgain: 'more', access: false,
	});
	noneBut(failed, 'retry');
	assert.deepEqual(planCatalogueRead(failed, 'retry'), { id: 4, generation: 1, intent: 'retry', offset: 200, limit: 100, key: 'catalogue:1:200', retry: true });
	const recovered = read(failed, 'retry', ok(page(200, [900])));
	assert.equal(recovered.columns.length, 201);
	assert.deepEqual(catalogueView(recovered).notices, []);
	assert.equal(catalogueView(recovered).more, 'none');
	// A refused later page keeps the columns but offers no Try again.
	const denied = read(pages, 'more', refused);
	assert.deepEqual(catalogueView(denied), {
		status: 'listed', columns: pages.columns, stale: false, more: 'none', notices: ['more-not-loaded', 'incomplete'], tryAgain: null, access: true,
	});
	noneBut(denied, null);
});

test('the only stop is the API maximum offset, and it is worded', () => {
	const listed = read(createCatalogue(), 'first', ok(page(0, range(1, 100), true)));
	// Deep in a long list: the next page is exactly the API's maximum offset, which it still accepts.
	const deep: CatalogueState = { ...listed, nextOffset: 1_000_000 };
	assert.equal(catalogueView(deep).more, 'offered');
	const { state: loading, request } = begin(deep, 'more');
	assert.equal(request.offset, 1_000_000);
	const last = finishCatalogueRead(loading, request, ok(page(1_000_000, range(2_000, 100), true)));
	assert.equal(last.nextOffset, 1_000_100);
	assert.deepEqual(catalogueView(last), {
		status: 'listed', columns: last.columns, stale: false, more: 'website', notices: ['listed-on-website'], tryAgain: null, access: false,
	});
	noneBut(last, null);
});

test('Refresh replaces the list from page 0 and drops a More answer still in flight', () => {
	const pages = twoPages();
	const { state: loading, request: more } = begin(pages, 'more');
	const refreshing = refreshCatalogue(loading);
	assert.equal(refreshing.generation, 2);
	assert.equal(refreshing.pending, null);
	assert.deepEqual(catalogueView(refreshing), {
		status: 'listed', columns: pages.columns, stale: true, more: 'none', notices: ['stale', 'more-not-loaded'], tryAgain: null, access: false,
	});
	noneBut(refreshing, 'refresh');
	assert.equal(finishCatalogueRead(refreshing, more, ok(page(200, [900]))), refreshing, 'the old More answer applies nothing');
	assert.equal(startCatalogueRead(refreshing, more), null, 'an old request can never start');
	const { state: reading, request } = begin(refreshing, 'refresh');
	assert.deepEqual(request, { id: 4, generation: 2, intent: 'refresh', offset: 0, limit: 100, key: 'catalogue:2:0', retry: false });
	assert.ok(request.id > more.id, 'request ids never repeat');
	assert.equal(finishCatalogueRead(reading, more, ok(page(200, [900]))), reading, 'still dropped while page 0 is outstanding');
	const replaced = finishCatalogueRead(reading, request, ok(page(0, [42, 7, ...range(1_000, 98)], true)));
	assert.deepEqual(ids(replaced).slice(0, 3), [42, 7, 1_000].map(uuid));
	assert.equal(replaced.columns.length, 100, 'only page 0; later pages are behind More again');
	assert.ok(!ids(replaced).includes(uuid(150)), 'equipment from old later pages is gone');
	assert.equal(replaced.list, 'current');
	assert.equal(replaced.nextOffset, 100);
	assert.deepEqual(planCatalogueRead(replaced, 'more')?.offset, 100);
});

test('a failed Refresh keeps the columns shown, labelled stale, with Try again', () => {
	const pages = twoPages();
	const failed = read(refreshCatalogue(pages), 'refresh', down);
	assert.deepEqual(ids(failed), ids(pages));
	assert.deepEqual(catalogueView(failed), {
		status: 'listed', columns: pages.columns, stale: true, more: 'none', notices: ['refresh-failed', 'more-not-loaded'], tryAgain: 'refresh', access: false,
	});
	noneBut(failed, 'retry');
	assert.equal(planCatalogueRead(failed, 'retry')?.offset, 0, 'Try again repeats page 0, never the old nextOffset');
	const recovered = read(failed, 'retry', ok(page(0, [5])));
	assert.deepEqual(ids(recovered), [uuid(5)]);
	assert.equal(catalogueView(recovered).stale, false);
	// A refused Refresh keeps the stale columns, with the access wording and no Try again.
	const denied = read(refreshCatalogue(pages), 'refresh', refused);
	assert.deepEqual(catalogueView(denied), {
		status: 'listed', columns: pages.columns, stale: true, more: 'none', notices: ['refresh-failed', 'more-not-loaded'], tryAgain: null, access: true,
	});
	// A stale empty list stays empty rather than inventing columns.
	const emptyStale = read(refreshCatalogue(read(createCatalogue(), 'first', ok(page(0, [])))), 'refresh', down);
	assert.equal(catalogueView(emptyStale).status, 'empty');
	assert.equal(catalogueView(emptyStale).stale, true);
});

test('Refresh during the first page drops it and owes page 0 again', () => {
	const { state: loading, request } = begin(createCatalogue(), 'first');
	const refreshing = refreshCatalogue(loading);
	assert.equal(catalogueView(refreshing).status, 'loading');
	assert.equal(finishCatalogueRead(refreshing, request, ok(page(0, [1]))), refreshing);
	noneBut(refreshing, 'refresh');
	// A failed first page, then Refresh: the failure is cleared and page 0 is read again.
	const retried = refreshCatalogue(read(createCatalogue(), 'first', down));
	assert.equal(catalogueView(retried).tryAgain, null);
	noneBut(retried, 'refresh');
});

test('an answer applies only once, and only to its own outstanding request', () => {
	const { state: loading, request } = begin(createCatalogue(), 'first');
	const done = finishCatalogueRead(loading, request, ok(page(0, [1], false)));
	assert.equal(finishCatalogueRead(done, request, ok(page(0, [2], false))), done, 'a repeated answer is dropped');
	const forged: CatalogueRequest = { ...request, id: 99 };
	const { state: more } = begin(read(createCatalogue(), 'first', ok(page(0, range(1, 100), true))), 'more');
	assert.equal(finishCatalogueRead(more, forged, down), more, 'an unknown request is dropped');
	const planned = planCatalogueRead(createCatalogue(), 'first')!;
	assert.equal(finishCatalogueRead(createCatalogue(), planned, down).failure, null, 'a planned but unstarted request applies nothing');
});

test('a page that does not fit its request is refused like any unusable answer', () => {
	const { state: loading, request } = begin(createCatalogue(), 'first');
	const wrong = finishCatalogueRead(loading, request, ok({ equipment: [], nextOffset: 300 }));
	assert.equal(catalogueView(wrong).status, 'failed');
	assert.equal(catalogueView(wrong).tryAgain, 'catalogue');
	const tooMany = { equipment: Array.from({ length: 101 }, (_, i) => ({ id: uuid(i + 1), name: 'x' })), nextOffset: null };
	assert.equal(catalogueView(finishCatalogueRead(loading, request, ok(tooMany))).status, 'failed');
});

test('runner outcomes map to catalogue answers; superseded applies nothing', () => {
	const value = page(0, [1]);
	assert.deepEqual(catalogueAnswer({ kind: 'ok', value }), { kind: 'page', page: value });
	assert.equal(catalogueAnswer({ kind: 'superseded' }), null);
	assert.deepEqual(catalogueAnswer({ kind: 'refused', status: 403 }), refused);
	assert.deepEqual(catalogueAnswer({ kind: 'refused', status: 404 }), refused);
	assert.deepEqual(catalogueAnswer({ kind: 'refused', status: 400 }), down);
	assert.deepEqual(catalogueAnswer({ kind: 'refused', status: 409 }), down);
	assert.deepEqual(catalogueAnswer({ kind: 'unavailable', wait: null }), down);
	assert.deepEqual(catalogueAnswer({ kind: 'unavailable', wait: { until: 5_000, about: 'later' } }), down);
	assert.deepEqual(catalogueAnswer({ kind: 'client-bug' }), down);
});

test('transitions never mutate the state they are given', () => {
	const pages = twoPages();
	const snapshot = JSON.stringify(pages);
	const { state: loading, request } = begin(pages, 'more');
	finishCatalogueRead(loading, request, ok(page(200, [1, 900])));
	refreshCatalogue(loading);
	catalogueView(loading);
	assert.equal(JSON.stringify(pages), snapshot);
	assert.equal(pages.pending, null);
});
