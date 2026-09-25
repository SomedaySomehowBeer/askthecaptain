import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isRetiredWorkflow } from './retired.ts';

test('the four assistant workflows are retired at every version', () => {
	for (const key of ['inbox-triage', 'discover-projects', 'calendar-prep', 'morning-brief']) {
		assert.equal(isRetiredWorkflow(key), true, key);
		assert.equal(isRetiredWorkflow(key, 1), true, key);
		assert.equal(isRetiredWorkflow(key, 99), true, key);
	}
});

test('old mail-drafting versions of chase-due and stocktake are retired; current ones are not', () => {
	assert.equal(isRetiredWorkflow('chase-due'), false);
	assert.equal(isRetiredWorkflow('chase-due', 3), true);
	assert.equal(isRetiredWorkflow('chase-due', 4), false);
	assert.equal(isRetiredWorkflow('stocktake'), false);
	assert.equal(isRetiredWorkflow('stocktake', 2), true);
	assert.equal(isRetiredWorkflow('stocktake', 3), false);
	assert.equal(isRetiredWorkflow('stocktake', Number.NaN), true);
});

test('unknown and look-alike keys are not retired', () => {
	for (const key of ['', 'Inbox-Triage', 'toString', '__proto__', 'constructor']) {
		assert.equal(isRetiredWorkflow(key), false, key);
		assert.equal(isRetiredWorkflow(key, 1), false, key);
	}
});
