import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFilters, type WorkFilters } from './filters.ts';
import { parseViewOffset, viewPageHref, viewsHref } from './saved-views.ts';
import { tagHeading, tagRowDetail, tagViewHref, workHeading } from './tag-views.ts';
import type { Tag } from './types.ts';

const production = '0199a1b2-0000-7000-8000-00000000000a';
const marketing = '0199a1b2-0000-7000-8000-00000000000b';
const project = '0199a1b2-0000-7000-8000-0000000000aa';
const loaded: Tag[] = [{ id: marketing, name: 'Marketing' }, { id: production, name: 'Production' }];
const tagFilter = (over: Partial<WorkFilters> = {}): WorkFilters => ({ owner: 'all', status: 'open', tagIds: [production], projectId: null, offset: 0, ...over });
const parsed = (href: string): WorkFilters => {
	const params = new URLSearchParams(href.split('?')[1] ?? '');
	const search: Record<string, string | string[]> = {};
	for (const key of new Set(params.keys())) { const all = params.getAll(key); search[key] = all.length === 1 ? all[0]! : all; }
	const result = parseFilters(search);
	assert.ok(result.ok, href);
	return result.filters;
};

test('a By tag row links by ID to exactly Everyone · that tag · Open, with no project', () => {
	assert.equal(tagViewHref(production), `/work?owner=all&tagId=${production}`);
	assert.equal(tagRowDetail, 'Everyone · Open');
	assert.deepEqual(parsed(tagViewHref(production)), { owner: 'all', status: 'open', tagIds: [production], projectId: null, offset: 0 });
});

test('the tag heading is the loaded name of the exact ID, on any task-result page', () => {
	assert.equal(tagHeading(tagFilter(), loaded), 'Production');
	assert.equal(tagHeading(tagFilter({ offset: 50 }), loaded), 'Production', 'a later task page keeps the heading');
	assert.equal(tagHeading(tagFilter({ offset: 1_000_000 }), loaded), 'Production');
	assert.equal(tagHeading(parsed(`${tagViewHref(production)}&tagId=${production}`), loaded), 'Production', 'a repeated identical tag is still one tag');
});

test('any other filter keeps its ordinary title', () => {
	for (const over of [{ owner: 'me' as const }, { status: 'all' as const }, { status: 'done' as const }, { projectId: project }, { tagIds: [] }, { tagIds: [production, marketing] }])
		assert.equal(tagHeading(tagFilter(over), loaded), null, JSON.stringify(over));
	// The Tags management link deliberately shows every non-cancelled status; it is not a By tag view.
	assert.equal(tagHeading(parsed(`/work?owner=all&status=all&tagId=${production}`), loaded), null);
});

test('no heading is guessed when the tag read failed, the tag is beyond the loaded page, or the ID does not resolve', () => {
	assert.equal(tagHeading(tagFilter(), null), null, 'tag read failed');
	const beyond = '0199a1b2-0000-7000-8000-000000000101';
	const firstHundred: Tag[] = Array.from({ length: 100 }, (_, i) => ({ id: `0199a1b2-0000-7000-8000-${String(i).padStart(12, '0')}`, name: `Tag ${String(i).padStart(3, '0')}` }));
	assert.equal(tagHeading(tagFilter({ tagIds: [beyond] }), firstHundred), null, 'the 101st tag is outside the loaded lookup');
	assert.equal(tagHeading(tagFilter({ tagIds: [beyond] }), []), null);
	// Never by name: another ID whose tag has the same name as a loaded one does not borrow it.
	assert.equal(tagHeading(tagFilter({ tagIds: [beyond] }), [{ id: production, name: 'Tag 101' }]), null);
	// The chip lookup is exact, so the heading is too: an upper-case ID is not treated as resolved.
	assert.equal(tagHeading(tagFilter({ tagIds: [production.toUpperCase()] }), loaded), null);
});

test('Work headings: saved views and drafts are never reinterpreted; plain filters fall back honestly', () => {
	assert.deepEqual(workHeading({ mode: 'plain', filters: tagFilter(), loadedTags: loaded }), { title: 'Production', eyebrow: 'Tag' });
	assert.deepEqual(workHeading({ mode: 'plain', filters: tagFilter(), loadedTags: null }), { title: 'All tasks' });
	assert.deepEqual(workHeading({ mode: 'plain', filters: tagFilter({ tagIds: ['0199a1b2-0000-7000-8000-000000000999'] }), loadedTags: loaded }), { title: 'All tasks' });
	assert.deepEqual(workHeading({ mode: 'plain', filters: tagFilter({ owner: 'me', status: 'open', tagIds: [] }), loadedTags: loaded }), { title: 'My work' });
	assert.deepEqual(workHeading({ mode: 'plain', filters: tagFilter({ owner: 'me' }), loadedTags: loaded }), { title: 'Assigned to you' });
	assert.deepEqual(workHeading({ mode: 'plain', filters: tagFilter({ tagIds: [] }), loadedTags: loaded }), { title: 'All tasks' });
	// A saved view whose filter happens to be one tag keeps its own name, as does its draft.
	assert.deepEqual(workHeading({ mode: 'saved', viewName: 'Brew days' }), { title: 'Brew days', eyebrow: 'Saved view' });
	assert.deepEqual(workHeading({ mode: 'draft', viewName: 'Brew days' }), { title: 'Brew days', eyebrow: 'Saved view · unsaved changes' });
});

test('both Work views cursors are strict, independent and bounded', () => {
	for (const [value, expected] of [[undefined, 0], ['', 0], ['0', 0], ['50', 50], ['1000000', 1_000_000]] as const) assert.equal(parseViewOffset(value), expected, String(value));
	for (const bad of ['25', '-50', 'x', '50x', '1.5e2', '1000050', '99999999', ['50', '50'], ['0', '50']]) assert.equal(parseViewOffset(bad), null, JSON.stringify(bad));
});

test('every views-page link keeps the other group’s cursor', () => {
	assert.equal(viewsHref(0, 0), '/work/views');
	assert.equal(viewsHref(null, null), '/work/views');
	assert.equal(viewsHref(50, 0), '/work/views?offset=50');
	assert.equal(viewsHref(0, 100), '/work/views?tagOffset=100');
	assert.equal(viewsHref(50, 100), '/work/views?offset=50&tagOffset=100');
	// By tag Next/Previous/first page/Try again with Saved views on page 3, and the reverse.
	const saved = 100, tag = 150;
	for (const href of [viewsHref(saved, tag + 50), viewsHref(saved, tag - 50), viewsHref(saved, 0), viewsHref(saved, tag)])
		assert.equal(new URL(href!, 'https://x.test').searchParams.get('offset'), '100', href!);
	for (const href of [viewsHref(saved + 50, tag), viewsHref(saved - 50, tag), viewsHref(0, tag), viewsHref(saved, tag)])
		assert.equal(new URL(href!, 'https://x.test').searchParams.get('tagOffset'), '150', href!);
	// A cursor that cannot be a page is never written; an unreadable other cursor is left out (its group shows page 1).
	for (const [offset, tagOffset] of [[25, 0], [0, 25], [-50, 0], [0, 1_000_050], [1_000_050, 0]] as const) assert.equal(viewsHref(offset, tagOffset), null, `${offset}/${tagOffset}`);
	assert.equal(viewsHref(null, 100), '/work/views?tagOffset=100');
	assert.equal(viewsHref(50, null), '/work/views?offset=50');
	// Round trip through the page's own parser.
	const round = new URL(viewsHref(250, 1_000_000)!, 'https://x.test').searchParams;
	assert.equal(parseViewOffset(round.get('offset') ?? undefined), 250);
	assert.equal(parseViewOffset(round.get('tagOffset') ?? undefined), 1_000_000);
});

test('the existing Saved views page helper still works and can carry the By tag cursor', () => {
	assert.equal(viewPageHref(0), '/work/views');
	assert.equal(viewPageHref(50), '/work/views?offset=50');
	assert.equal(viewPageHref(null), null);
	assert.equal(viewPageHref(50, 100), '/work/views?offset=50&tagOffset=100');
	assert.equal(viewPageHref(null, 100), null);
});
