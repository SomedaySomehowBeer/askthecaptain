import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiQuery, defaultFilters, isDefault, nextHref, parseFilters, projectLabel, unlistedTags, workHref, type Search, type WorkFilters } from './filters.ts';

const tagA = '0199a1b2-0000-7000-8000-00000000000a';
const tagB = '0199a1b2-0000-7000-8000-00000000000b';
const project = '0199a1b2-0000-7000-8000-0000000000aa';
const me = '0199a1b2-0000-7000-8000-0000000000ee';
const read = (search: Search): WorkFilters => { const parsed = parseFilters(search); assert.ok(parsed.ok, JSON.stringify(parsed)); return parsed.filters; };
const problems = (search: Search): string[] => { const parsed = parseFilters(search); assert.equal(parsed.ok, false); return parsed.ok ? [] : parsed.problems; };

test('plain /work is My work: open tasks assigned to the person, and its URL stays plain', () => {
	const filters = read({});
	assert.deepEqual(filters, defaultFilters);
	assert.ok(isDefault(filters));
	assert.equal(workHref(filters), '/work');
	assert.equal(apiQuery(filters, me), `ownerId=${me}&status=open&offset=0&limit=50`);
});

test('filters round-trip through the URL; repeated tags are kept once and match any of them', () => {
	const filters = read({ owner: 'all', status: 'done', tagId: [tagA, tagB, tagA], projectId: project, offset: '100' });
	assert.deepEqual(filters, { owner: 'all', status: 'done', tagIds: [tagA, tagB], projectId: project, offset: 100 });
	const search = new URLSearchParams(workHref(filters, { offset: filters.offset }).split('?')[1]);
	assert.deepEqual(search.getAll('tagId'), [tagA, tagB]);
	assert.equal(search.get('offset'), '100');
	// Everyone's work sends no owner to the API; status `all` sends no status (the API then leaves out cancelled).
	assert.equal(apiQuery(read({ owner: 'all', status: 'all' }), me), 'offset=0&limit=50');
	assert.equal(apiQuery(filters, me), `status=done&tagId=${tagA}&tagId=${tagB}&projectId=${project}&offset=100&limit=50`);
});

test('changing a filter returns to the first page; removing one filter keeps the others', () => {
	const filters = read({ owner: 'all', tagId: [tagA, tagB], projectId: project, offset: '50' });
	assert.equal(workHref(filters, { tagIds: [tagB] }), `/work?owner=all&tagId=${tagB}&projectId=${project}`);
	assert.equal(workHref(filters, { projectId: null }), `/work?owner=all&tagId=${tagA}&tagId=${tagB}`);
	assert.equal(workHref(filters, { offset: 100 }), `/work?owner=all&tagId=${tagA}&tagId=${tagB}&projectId=${project}&offset=100`);
});

test('an empty form field is no filter, not an invalid one', () => {
	assert.deepEqual(read({ owner: 'me', status: 'open', projectId: '' }), defaultFilters);
});

test('what cannot be read is said, never guessed', () => {
	assert.equal(problems({ owner: 'someone' }).length, 1);
	assert.equal(problems({ status: 'waiting' }).length, 1);
	assert.equal(problems({ projectId: 'not-a-project' }).length, 1);
	assert.equal(problems({ tagId: [tagA, 'nope'] }).length, 1);
	assert.equal(problems({ tagId: Array.from({ length: 21 }, (_, i) => `0199a1b2-0000-7000-8000-${String(i).padStart(12, '0')}`) }).length, 1);
	assert.equal(problems({ status: ['open', 'done'] }).length, 1);
	for (const offset of ['-50', '25', '1e3', 'abc', '1000050', '9999950']) assert.equal(problems({ offset }).length, 1, offset);
	assert.equal(read({ offset: '1000000' }).offset, 1_000_000);
});

test('selected tags missing from the loaded list, or from a failed read, stay selected', () => {
	assert.deepEqual(unlistedTags([tagA, tagB], [{ id: tagA }]), [tagB]);
	assert.deepEqual(unlistedTags([tagA, tagB], null), [tagA, tagB]);
	assert.deepEqual(unlistedTags([], null), []);
});

test('a selected project that cannot be offered keeps its name and says why', () => {
	assert.equal(projectLabel({ name: 'Summer lager', state: 'active' }), 'Summer lager');
	assert.equal(projectLabel({ name: 'Summer lager', state: 'archived' }), 'Summer lager (archived)');
	assert.equal(projectLabel({ name: 'Taproom', state: 'proposed' }), 'Taproom (proposed)');
	assert.equal(projectLabel(undefined), 'Unknown project');
});

test('the next page is offered only while the API can serve it', () => {
	const filters = read({ offset: '999950' });
	assert.equal(nextHref(filters, 1_000_000), '/work?offset=1000000');
	assert.equal(nextHref(filters, 1_000_050), null);
	assert.equal(nextHref(filters, null), null);
});
