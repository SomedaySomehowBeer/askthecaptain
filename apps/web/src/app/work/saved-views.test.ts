import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiQuery } from './filters.ts';
import {
	describeFilter, describeRow, draftChange, draftHref, filtersFor, isViewId, normaliseFilter, parseViewOffset, parseWorkUrl, readFilter, readView,
	reconcileFilterSave, reconcileRename, referenceLabels, sameScope, scopeKey, referenceNotes, sameFilter, savedHref, viewName, viewPageHref, type SavedFilter, type SavedView, type WorkUrl
} from './saved-views.ts';

const view = '0199a1b2-0000-7000-8000-0000000000f1';
const tagA = '0199a1b2-0000-7000-8000-00000000000a';
const tagB = '0199a1b2-0000-7000-8000-00000000000b';
const project = '0199a1b2-0000-7000-8000-0000000000aa';
const me = '0199a1b2-0000-7000-8000-0000000000ee';
const saved: SavedFilter = { owner: 'all', status: 'open', tagIds: [tagA, tagB], projectId: project };
const search = (href: string) => {
	const params = new URLSearchParams(href.split('?')[1] ?? '');
	const out: Record<string, string | string[]> = {};
	for (const key of new Set(params.keys())) { const all = params.getAll(key); out[key] = all.length === 1 ? all[0]! : all; }
	return out;
};
const as = <M extends WorkUrl['mode']>(url: WorkUrl, mode: M): Extract<WorkUrl, { mode: M }> => { assert.equal(url.mode, mode, JSON.stringify(url)); return url as Extract<WorkUrl, { mode: M }>; };
const viewOf = (over: Partial<SavedView> = {}): SavedView => ({ id: view, name: 'Production', filterVersion: 1, filter: saved, applicable: true, reason: null, revision: 3, createdAt: '', updatedAt: '', ...over });

test('filters are stored normalised: lower-cased UUIDs, unique sorted tags, like API v1', () => {
	const upper = normaliseFilter({ owner: 'me', status: 'done', tagIds: [tagB.toUpperCase(), tagA, tagB], projectId: project.toUpperCase() });
	assert.deepEqual(upper, { owner: 'me', status: 'done', tagIds: [tagA, tagB], projectId: project });
	assert.ok(sameFilter({ ...saved, tagIds: [tagB, tagA.toUpperCase()] }, saved));
	assert.ok(!sameFilter({ ...saved, tagIds: [] }, saved));
	assert.ok(!sameFilter({ ...saved, projectId: null }, saved));
});

test('a stored filter is read strictly as version 1, and a newer or odd one is never cast', () => {
	assert.ok(readFilter(saved).ok);
	for (const bad of [null, [], { owner: 'me', status: 'open', tagIds: [] }, { ...saved, extra: 1 }, { ...saved, owner: 'someone' }, { ...saved, status: 'waiting' },
		{ ...saved, tagIds: ['nope'] }, { ...saved, projectId: 'nope' }, { ...saved, tagIds: Array.from({ length: 21 }, (_, i) => `0199a1b2-0000-7000-8000-${String(i).padStart(12, '0')}`) }])
		assert.equal(readFilter(bad).ok, false, JSON.stringify(bad));
	const newer = readView(viewOf({ applicable: false, reason: 'Filter version 2 is newer than this server reads.', filterVersion: 2, filter: { anything: true }, references: null }));
	assert.deepEqual(newer, { ok: false, state: 'newer', reason: 'Filter version 2 is newer than this server reads.' });
	// Even if a server wrongly said applicable, this client only opens version 1.
	assert.equal((readView(viewOf({ filterVersion: 2 })) as { state: string }).state, 'newer');
	assert.equal((readView(viewOf({ filter: { ...saved, extra: true } })) as { state: string }).state, 'unreadable');
	assert.deepEqual(readView(viewOf()), { ok: true, filter: saved });
});

test('an unreadable version-1 view is "could not be read", not "needs a newer Captain"', () => {
	const reason = 'This view’s saved filter could not be read, so it is not applied.';
	assert.deepEqual(readView(viewOf({ applicable: false, reason, filterVersion: 1, filter: { owner: 'me' }, references: null })), { ok: false, state: 'unreadable', reason });
	assert.equal((readView(viewOf({ applicable: false, reason: 'x', filterVersion: 3 })) as { state: string }).state, 'newer');
	assert.equal(describeRow(viewOf({ applicable: false, reason, filterVersion: 1, filter: {} }), { tags: new Map(), projects: new Map() }), 'This view cannot be read');
	assert.equal(describeRow(viewOf({ applicable: false, reason: 'newer', filterVersion: 2 }), { tags: new Map(), projects: new Map() }), 'Needs a newer version of Captain');
});

test('a view id the API would refuse is an invalid link, not a failed read', () => {
	for (const id of ['00000000-0000-0000-0000-000000000001', '0199a1b2-0000-0000-8000-0000000000f1', '0199a1b2-0000-7000-c000-0000000000f1', '0199a1b2-0000-9000-8000-0000000000f1'])
		assert.equal(parseWorkUrl({ view: id }).mode, 'invalid', id);
	assert.ok(isViewId(view)); assert.ok(isViewId('00000000-0000-0000-0000-000000000000'));
	assert.ok(isViewId('3f2504e0-4f89-41d3-9a0c-0305e82c3301'));
});

test('an uncertain filter save is reconciled against the revision actually sent, including an explicit Replace', () => {
	const draft: SavedFilter = { owner: 'me', status: 'open', tagIds: [], projectId: null };
	// Save changes sent against base 3.
	assert.equal(reconcileFilterSave(3, draft, viewOf({ revision: 4, filter: draft })), 'saved');
	assert.equal(reconcileFilterSave(3, draft, viewOf({ revision: 3 })), 'not-saved');
	assert.equal(reconcileFilterSave(3, draft, viewOf({ revision: 4 })), 'changed');
	// Replace sent against revision 5 after a conflict (base still 3): unchanged at 5 means it did not land —
	// not "changed elsewhere", which comparing with base would wrongly say.
	assert.equal(reconcileFilterSave(5, draft, viewOf({ revision: 5 })), 'not-saved');
	assert.equal(reconcileFilterSave(5, draft, viewOf({ revision: 6, filter: draft })), 'saved');
	assert.equal(reconcileFilterSave(5, draft, viewOf({ revision: 6, filter: saved })), 'changed');
	assert.equal(reconcileFilterSave(5, draft, viewOf({ revision: 6, applicable: false, reason: 'x', filterVersion: 2, filter: draft })), 'changed');
});

test('an action only runs for the person and organisation its page was rendered for', () => {
	const now = { userId: me, organisationId: project };
	assert.ok(sameScope({ userId: me.toUpperCase(), organisationId: project }, now));
	assert.ok(!sameScope({ userId: me, organisationId: view }, now), 'organisation cookie switched in another tab');
	assert.ok(!sameScope({ userId: view, organisationId: project }, now), 'another person signed in');
	for (const bad of [undefined, null, 'scope', {}, { userId: me }, { organisationId: project }, { userId: 1, organisationId: project }])
		assert.ok(!sameScope(bad, now), JSON.stringify(bad));
	assert.equal(scopeKey({ userId: me.toUpperCase(), organisationId: project }), `${me}:${project}`);
	assert.notEqual(scopeKey(now), scopeKey({ userId: me, organisationId: view }));
});

test('a rename retried after it had already landed is recognised as saved, not as a conflict', () => {
	assert.equal(reconcileRename(3, 'Brewing', viewOf({ revision: 4, name: 'Brewing' })), 'saved');
	assert.equal(reconcileRename(3, 'Brewing', viewOf({ revision: 3, name: 'Production' })), 'not-saved');
	assert.equal(reconcileRename(3, 'Brewing', viewOf({ revision: 5, name: 'Packaging' })), 'changed');
	assert.equal(reconcileRename(3, 'Brewing', null), 'changed');
});

test('/work?view=<id> is the unmodified view; paging keeps it unmodified; the id is normalised', () => {
	assert.deepEqual(parseWorkUrl({}), { mode: 'plain' });
	assert.deepEqual(parseWorkUrl({ owner: 'all' }), { mode: 'plain' });
	assert.deepEqual(parseWorkUrl({ view: view.toUpperCase() }), { mode: 'saved', viewId: view, offset: 0 });
	assert.deepEqual(parseWorkUrl(search(savedHref(view, 100))), { mode: 'saved', viewId: view, offset: 100 });
	assert.equal(savedHref(view), `/work?view=${view}`);
	// The saved filter applies with its exact stored IDs, through the ordinary work query.
	assert.equal(apiQuery(filtersFor(saved), me), `status=open&tagId=${tagA}&tagId=${tagB}&projectId=${project}&offset=0&limit=50`);
});

test('a view link mixed with filter parameters is inconsistent, never quietly merged', () => {
	for (const extra of [{ owner: 'me' }, { status: 'done' }, { tagId: tagA }, { tagId: 'none' }, { projectId: project }, { base: '3' }])
		assert.deepEqual(parseWorkUrl({ view, ...extra }), { mode: 'inconsistent', viewId: view }, JSON.stringify(extra));
	assert.equal(parseWorkUrl({ view: 'not-a-view' }).mode, 'invalid');
	assert.equal(parseWorkUrl({ view: [view, view] }).mode, 'invalid');
	assert.equal(parseWorkUrl({ base: '3', draft: '1', owner: 'me' }).mode, 'invalid');
	assert.equal(parseWorkUrl({ view, offset: '25' }).mode, 'invalid');
});

test('a draft URL writes every key explicitly, including cleared tags and project, and round-trips', () => {
	const cleared = { owner: 'me' as const, status: 'all' as const, tagIds: [], projectId: null };
	const href = draftHref(view, 3, cleared);
	const params = new URLSearchParams(href.split('?')[1]);
	assert.deepEqual([...params.keys()], ['view', 'base', 'draft', 'owner', 'status', 'tagId', 'projectId']);
	assert.equal(params.get('tagId'), 'none'); assert.equal(params.get('projectId'), 'none'); assert.equal(params.get('owner'), 'me'); assert.equal(params.get('status'), 'all');
	assert.deepEqual(parseWorkUrl(search(href)), { mode: 'draft', viewId: view, base: 3, filter: cleared, offset: 0 });
	const full = as(parseWorkUrl(search(draftHref(view, 3, { ...saved, tagIds: [tagB.toUpperCase(), tagA] }, 50))), 'draft');
	assert.deepEqual(full, { mode: 'draft', viewId: view, base: 3, filter: saved, offset: 50 });
});

test('a draft keeps the base it began from through filter changes, chip removal and paging', () => {
	let href = draftChange(view, 3, saved, { status: 'done' });
	for (const change of [{ tagIds: [tagA] }, { projectId: null }, { offset: 100 }, { owner: 'me' as const }]) {
		const draft = as(parseWorkUrl(search(href)), 'draft');
		assert.equal(draft.base, 3);
		href = draftChange(draft.viewId, draft.base, draft.filter, change);
	}
	const last = as(parseWorkUrl(search(href)), 'draft');
	assert.deepEqual(last, { mode: 'draft', viewId: view, base: 3, filter: { owner: 'me', status: 'done', tagIds: [tagA], projectId: null }, offset: 0 });
	// Paging returns to the first page on any filter change, but keeps the page when only paging.
	assert.equal(as(parseWorkUrl(search(draftChange(view, 3, saved, { offset: 50 }))), 'draft').offset, 50);
});

test('incomplete or contradictory drafts are refused, not completed from the stored view', () => {
	const complete = search(draftHref(view, 3, saved));
	for (const key of ['owner', 'status', 'tagId', 'projectId', 'base']) {
		const partial = { ...complete }; delete partial[key];
		assert.equal(parseWorkUrl(partial).mode, 'invalid', key);
	}
	assert.equal(parseWorkUrl({ ...complete, tagId: ['none', tagA] }).mode, 'invalid');
	assert.equal(parseWorkUrl({ ...complete, draft: '2' }).mode, 'invalid');
	for (const base of ['0', '-1', 'x', '1.5', '99999999999']) assert.equal(parseWorkUrl({ ...complete, base }).mode, 'invalid', base);
	assert.equal(parseWorkUrl({ ...complete, projectId: 'nope' }).mode, 'invalid');
});

test('the no-JS filter form becomes the complete draft URL: absent tags and "Any project" are explicit clears', () => {
	const edit = as(parseWorkUrl({ view, base: '3', edit: '1', owner: 'all', status: 'open', projectId: '' }), 'edit');
	assert.equal(edit.href, draftHref(view, 3, { owner: 'all', status: 'open', tagIds: [], projectId: null }));
	assert.match(edit.href, /tagId=none/); assert.match(edit.href, /projectId=none/);
	const tagged = as(parseWorkUrl({ view, base: '7', edit: '1', owner: 'me', status: 'done', tagId: [tagB, tagA.toUpperCase()], projectId: project }), 'edit');
	assert.deepEqual(parseWorkUrl(search(tagged.href)), { mode: 'draft', viewId: view, base: 7, filter: { owner: 'me', status: 'done', tagIds: [tagA, tagB], projectId: project }, offset: 0 });
	assert.equal(parseWorkUrl({ view, base: '3', edit: '1', owner: 'all' }).mode, 'invalid');
	assert.equal(parseWorkUrl({ view, edit: '1', owner: 'all', status: 'open' }).mode, 'invalid');
});

test('the filter in words says every term in order, including explicit "Any tag" and "Any project"', () => {
	const labels = { tag: (id: string) => (id === tagA ? 'Production' : 'Sales'), project: () => 'Summer lager' };
	assert.equal(describeFilter({ owner: 'me', status: 'open', tagIds: [tagA], projectId: null }, labels), 'Assigned to you · Tag: Production · Open · Any project');
	assert.equal(describeFilter(saved, labels), 'Everyone · Tags: Production, Sales · Open · Project: Summer lager');
	assert.equal(describeFilter({ owner: 'all', status: 'all', tagIds: [], projectId: null }, labels), 'Everyone · Any tag · Any status but cancelled · Any project');
});

test('missing and unavailable references read differently, and neither drops an ID from the filter', () => {
	const refs = { tags: [{ id: tagA, state: 'missing' as const }, { id: tagB, state: 'unavailable' as const }], project: { id: project, state: 'available' as const, name: 'Summer lager', projectState: 'archived' as const } };
	const labels = referenceLabels(refs, { tags: new Map(), projects: new Map() });
	assert.equal(labels.tag(tagA), 'Missing tag');
	assert.equal(labels.tag(tagB), 'Tag name unavailable');
	assert.equal(labels.project(project), 'Summer lager (archived)');
	// A listed name may still name an unavailable reference; a missing one stays missing.
	const listed = referenceLabels(refs, { tags: new Map([[tagA, 'Old'], [tagB, 'Sales']]), projects: new Map() });
	assert.equal(listed.tag(tagA), 'Missing tag'); assert.equal(listed.tag(tagB), 'Sales');
	const notes = referenceNotes(refs);
	assert.equal(notes.length, 2);
	assert.match(notes[0]!, /no longer exists\. The view still filters by it/);
	assert.equal(notes[1], 'Tag names could not be read; the view still filters by them.');
	assert.deepEqual(referenceNotes({ tags: [], project: { id: project, state: 'unavailable' } }), ['The project name could not be read; the view still filters by it.']);
	assert.deepEqual(referenceNotes({ tags: [], project: { id: project, state: 'missing' } }).length, 1);
	assert.deepEqual(referenceNotes(null), []);
	assert.equal(referenceLabels(null, { tags: new Map([[tagA, 'Production']]), projects: new Map() }).tag(tagA), 'Production');
	assert.equal(referenceLabels({ tags: [], project: { id: project, state: 'missing' } }, { tags: new Map(), projects: new Map() }).project(project), 'Missing project');
	// Whatever the references say, the query still carries every stored ID.
	assert.match(apiQuery(filtersFor(saved), me), new RegExp(`tagId=${tagA}&tagId=${tagB}&projectId=${project}`));
});

test('list rows name tags only from a loaded page, otherwise count them; newer views say so', () => {
	assert.equal(describeRow(viewOf(), { tags: new Map([[tagA, 'Production'], [tagB, 'Sales']]), projects: new Map([[project, 'Summer lager']]) }), 'Tags: Production, Sales · Everyone · Open · Project: Summer lager');
	assert.equal(describeRow(viewOf(), { tags: new Map([[tagA, 'Production']]), projects: new Map() }), '2 tags · Everyone · Open · Project: one project');
	assert.equal(describeRow(viewOf({ applicable: false, reason: 'newer', filterVersion: 2, filter: { mode: 'board' } }), { tags: new Map(), projects: new Map() }), 'Needs a newer version of Captain');
});

test('view names and the saved view list pages are bounded like the API', () => {
	assert.equal(viewName('  Production  '), 'Production');
	assert.deepEqual(viewName('   '), { error: 'Give the view a name.' });
	assert.equal(typeof viewName('x'.repeat(61)), 'object');
	assert.equal(viewName('x'.repeat(60)), 'x'.repeat(60));
	assert.equal(parseViewOffset(undefined), 0); assert.equal(parseViewOffset('50'), 50);
	for (const bad of ['25', '-50', 'x', '1000050']) assert.equal(parseViewOffset(bad), null, bad);
	assert.equal(viewPageHref(0), '/work/views'); assert.equal(viewPageHref(50), '/work/views?offset=50'); assert.equal(viewPageHref(null), null);
});
