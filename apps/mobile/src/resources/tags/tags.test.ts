import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyTagForm, parseOneTag, parseTagCatalogue, parseTagWrite, tagChanges, tagDetail, tagForm, tagProblem, tagWrites } from './tags.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = { epoch: 'one', userId: id(1), organisationId: id(2) };
const at = '2026-10-01T00:00:00.000Z';
const tag = (n: number, x: Record<string, unknown> = {}) => ({ id: id(n), name: `Tag ${n}`, ownerId: null, startsOn: null, endsOn: null, archivedAt: null, revision: 1, createdBy: id(1), createdAt: at, updatedAt: at, threads: 2, ...x });

test('the tag list with counts and one tag are read strictly', () => {
	const list = parseTagCatalogue({ tags: [tag(10), tag(11, { ownerId: id(4), startsOn: '2031-06-01', endsOn: '2031-08-31', threads: 0 }), tag(12, { archivedAt: at })], nextOffset: null });
	assert.deepEqual(list.tags.map((t) => [t.name, t.threads, t.archivedAt !== null]), [['Tag 10', 2, false], ['Tag 11', 0, false], ['Tag 12', 2, true]]);
	for (const bad of [{ tags: [{ ...tag(10), threads: undefined }], nextOffset: null }, { tags: [tag(10), tag(10)], nextOffset: null }, { tags: [tag(10, { startsOn: '2031-02-30' })], nextOffset: null },
		{ tags: [tag(10, { startsOn: '2031-06-02', endsOn: '2031-06-01' })], nextOffset: null }, { tags: [tag(10, { name: ' Padded' })], nextOffset: null }, { tags: [tag(10)], nextOffset: 50 }, { tags: [tag(10, { extra: 1 })], nextOffset: null }])
		assert.throws(() => parseTagCatalogue(bad), TypeError);
	assert.equal(parseOneTag(tag(10), id(10)).threads, 2);
	assert.throws(() => parseOneTag(tag(10), id(11)), TypeError, 'another tag');
});

test('the form says what is wrong; a save names only what changed, and the answer must match it', () => {
	assert.equal(tagProblem({ ...emptyTagForm, name: '  ' }), 'Enter a name for the tag.');
	assert.equal(tagProblem({ ...emptyTagForm, name: 'x'.repeat(121) }), 'A name is at most 120 characters.');
	assert.equal(tagProblem({ ...emptyTagForm, name: 'Launch', startsOn: '2031-06-02', endsOn: '2031-06-01' }), 'The end date cannot be before the start date.');
	assert.equal(tagProblem({ ...emptyTagForm, name: 'Launch', startsOn: '2031-06-01' }), null);
	const current = parseOneTag(tag(10, { ownerId: id(4), startsOn: '2031-06-01', revision: 3 }), id(10));
	assert.equal(tagChanges(current, tagForm(current)), null);
	assert.deepEqual(tagChanges(current, { ...tagForm(current), name: ' Launch ', ownerId: '', endsOn: '2031-08-31' }), { name: 'Launch', ownerId: null, endsOn: '2031-08-31' });
	assert.deepEqual(tagChanges(current, { ...tagForm(current), startsOn: '' }), { startsOn: null });
	const w = tagWrites.update(scope, current, id(900), { name: 'Launch' });
	assert.deepEqual([w.method, w.path, w.body], ['PATCH', `/v1/organisations/${id(2)}/tags/${id(10)}`, { changeSetId: id(900), expectedRevision: 3, name: 'Launch' }]);
	const { threads: _, ...answer } = tag(10, { name: 'Launch', ownerId: id(4), startsOn: '2031-06-01', revision: 4, changeSetId: id(900) });
	assert.equal(w.parse(answer).revision, 4);
	assert.throws(() => w.parse({ ...answer, changeSetId: id(901) }), TypeError, 'another change set');
	assert.throws(() => w.parse({ ...answer, name: 'Other' }), TypeError, 'not the value asked for');
	const add = tagWrites.add(scope, id(902), { name: ' Summer ', ownerId: id(4), startsOn: '', endsOn: '2031-09-01' });
	assert.deepEqual([add.method, add.body], ['POST', { changeSetId: id(902), name: 'Summer', ownerId: id(4), endsOn: '2031-09-01' }]);
	assert.throws(() => parseTagWrite({ ...answer, archivedAt: at }, { id: id(10), changeSetId: id(900), patch: { archived: false } }), TypeError);
	assert.equal(tagDetail(current, 'Maya Chen', '1 Jun'), 'Maya Chen · 1 Jun · 2 threads');
	assert.equal(tagDetail(parseOneTag(tag(10, { threads: 1, archivedAt: at }), id(10)), null, ''), '1 thread · Archived');
});
