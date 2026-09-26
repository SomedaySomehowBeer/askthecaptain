import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearPending, decodePending, encodePending, loadPending, maxWords, pendingKey, savePending, type CreateScope, type PendingCreate, type StorageLike } from './pending-create.ts';
import { describeFilter, normaliseFilter } from './saved-views.ts';

const scope: CreateScope = { userId: '0199a1b2-0000-7000-8000-0000000000ee', organisationId: '0199a1b2-0000-7000-8000-0000000000dd' };
const record: PendingCreate = {
	id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', name: 'Production',
	filter: { owner: 'all', status: 'open', tagIds: ['0199a1b2-0000-7000-8000-00000000000a'], projectId: null },
	words: 'Everyone · Tag: Production · Open · Any project'
};
/** A tab's sessionStorage: survives a reload of the page, not the tab. */
function tab(): StorageLike & { map: Map<string, string> } {
	const map = new Map<string, string>();
	return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, String(v)); }, removeItem: (k) => { map.delete(k); } };
}
const broken: StorageLike = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('QuotaExceededError'); }, removeItem: () => { throw new Error('SecurityError'); } };

test('a create is kept before it is sent and restored, exactly, after a reload of the tab', () => {
	const storage = tab();
	assert.deepEqual(loadPending(storage, scope), { state: 'none' });
	assert.equal(savePending(storage, scope, record), true);
	// The page reloads: component state is gone; only the tab's storage remains.
	const restored = loadPending(storage, scope);
	assert.deepEqual(restored, { state: 'found', record });
	// Same id and normalised payload, so a retry is the same logical create.
	assert.equal(restored.state === 'found' && restored.record.id, record.id);
	// Cleared only when resolved (or by an explicit new view); then nothing is restored.
	assert.equal(clearPending(storage, scope), true);
	assert.deepEqual(loadPending(storage, scope), { state: 'none' });
});

test('the record is scoped to the signed-in person and organisation, and holds no session material', () => {
	const storage = tab();
	savePending(storage, scope, record);
	assert.deepEqual(loadPending(storage, { ...scope, userId: '0199a1b2-0000-7000-8000-0000000000ef' }), { state: 'none' });
	assert.deepEqual(loadPending(storage, { ...scope, organisationId: '0199a1b2-0000-7000-8000-0000000000de' }), { state: 'none' });
	// Someone else's record copied under this key is refused, not adopted.
	const foreign = encodePending({ ...scope, userId: '0199a1b2-0000-7000-8000-0000000000ef' }, record);
	storage.setItem(pendingKey(scope), foreign);
	assert.deepEqual(loadPending(storage, scope), { state: 'invalid' });
	const text = encodePending(scope, record);
	assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ['filter', 'id', 'name', 'organisationId', 'userId', 'v', 'words']);
	assert.doesNotMatch(text, /token|session|bearer/i);
});

test('a restored record is validated, never trusted', () => {
	const good = JSON.parse(encodePending(scope, record)) as Record<string, unknown>;
	const variants: unknown[] = [
		'not json', '[]', 'null',
		{ ...good, v: 2 }, { ...good, extra: true }, { ...good, id: 'nope' }, { ...good, id: '00000000-0000-0000-0000-000000000001' },
		{ ...good, id: record.id.toUpperCase() }, { ...good, name: '  Production ' }, { ...good, name: '' }, { ...good, name: 'x'.repeat(61) },
		{ ...good, filter: { ...record.filter, extra: 1 } }, { ...good, filter: { ...record.filter, owner: 'someone' } },
		{ ...good, filter: { ...record.filter, tagIds: ['0199a1b2-0000-7000-8000-00000000000b', '0199a1b2-0000-7000-8000-00000000000a'] } },
		{ ...good, filter: { ...record.filter, tagIds: ['0199A1B2-0000-7000-8000-00000000000A'] } },
		{ ...good, words: '' }, { ...good, words: 'x'.repeat(maxWords + 1) }, { ...good, words: 3 }
	];
	for (const value of variants) assert.deepEqual(decodePending(scope, typeof value === 'string' ? value : JSON.stringify(value)), { state: 'invalid' }, JSON.stringify(value));
	assert.equal(decodePending(scope, JSON.stringify(good)).state, 'found');
});

test('the longest real description (20 sixty-character tags and an archived project) is kept and restored', () => {
	const tagIds = Array.from({ length: 20 }, (_, i) => `0199a1b2-0000-7000-8000-${String(i).padStart(12, '0')}`);
	const project = '0199a1b2-0000-7000-8000-0000000000aa';
	const longName = (i: number) => `${String(i).padStart(2, '0')} ${'Ünïcödé production line '.repeat(3)}`.slice(0, 60);
	const filter = normaliseFilter({ owner: 'all', status: 'all', tagIds, projectId: project });
	const words = describeFilter(filter, { tag: (id) => longName(tagIds.indexOf(id)), project: () => `${'P'.repeat(60)} (archived)` });
	assert.ok(words.length > 1_200 && words.length < 1_600, String(words.length));
	assert.ok(words.length <= maxWords);
	const storage = tab();
	const long = { id: record.id, name: 'x'.repeat(60), filter, words };
	assert.equal(savePending(storage, scope, long), true);
	assert.deepEqual(loadPending(storage, scope), { state: 'found', record: long });
});

test('unavailable or failing storage is reported, never mistaken for "no pending save"', () => {
	assert.equal(savePending(null, scope, record), false);
	assert.deepEqual(loadPending(null, scope), { state: 'unavailable' });
	assert.equal(savePending(broken, scope, record), false);
	assert.deepEqual(loadPending(broken, scope), { state: 'unavailable' });
	assert.equal(clearPending(broken, scope), false);
});
