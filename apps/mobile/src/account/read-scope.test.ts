import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReadScope } from './contracts.ts';
import { scopeInert } from './read-scope.ts';

test('a list is bound to its first ready scope: any other scope makes it inert, before navigation resets', () => {
	const a: ReadScope = { epoch: 'a1.o1', userId: 'u', organisationId: 'org-a' };
	assert.equal(scopeInert(a, a), false);
	assert.equal(scopeInert(a, { ...a }), false, 'an equal scope object is the same scope');
	// The render after a switch, before RootStack's effect returns to the thread list: a new epoch and organisation.
	assert.equal(scopeInert(a, { epoch: 'a1.o2', userId: 'u', organisationId: 'org-b' }), true);
	// A → B → A: the same organisation again is a new epoch, so still inert.
	assert.equal(scopeInert(a, { epoch: 'a1.o3', userId: 'u', organisationId: 'org-a' }), true);
	assert.equal(scopeInert(a, null), true, 'not ready');
	assert.equal(scopeInert(null, a), true, 'never bound');
});
