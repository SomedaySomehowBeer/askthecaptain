import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOrganisationMemory, organisationMemoryKey, type KeyValueStorage } from './web-storage.ts';

const userId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const orgA = 'c0ffee00-1234-4abc-9def-0123456789ab';

const fake = (): KeyValueStorage & { map: Map<string, string> } => {
	const map = new Map<string, string>();
	return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); }, removeItem: (k) => { map.delete(k); } };
};

test('the choice is kept under the user id, read back exactly, and forgotten on request', () => {
	const storage = fake(); const memory = createOrganisationMemory(() => storage);
	assert.equal(memory.read(userId), null);
	assert.equal(memory.write(userId, orgA), true);
	assert.deepEqual([...storage.map], [[organisationMemoryKey(userId), orgA]]);
	assert.equal(memory.read(userId), orgA);
	memory.forget(userId);
	assert.equal(memory.read(userId), null);
});

test('an unusable stored value, a bad id, a missing storage or a throwing one never throws and never writes', () => {
	const storage = fake(); const memory = createOrganisationMemory(() => storage);
	storage.map.set(organisationMemoryKey(userId), 'sess_not-an-organisation');
	assert.equal(memory.read(userId), null);
	assert.equal(memory.write(userId, 'not-a-uuid'), false); assert.equal(memory.write('x', orgA), false);
	assert.equal(memory.read('not-a-uuid'), null);
	assert.equal(storage.map.size, 1, 'nothing was written for a refused id');
	const none = createOrganisationMemory(() => null);
	assert.equal(none.read(userId), null); assert.equal(none.write(userId, orgA), false); none.forget(userId);
	const throwing = createOrganisationMemory(() => { throw new Error('SecurityError'); });
	assert.equal(throwing.read(userId), null); assert.equal(throwing.write(userId, orgA), false); throwing.forget(userId);
	const brokenWrite = createOrganisationMemory(() => ({ getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); }, removeItem: () => { throw new Error('x'); } }));
	assert.equal(brokenWrite.write(userId, orgA), false); brokenWrite.forget(userId);
});
