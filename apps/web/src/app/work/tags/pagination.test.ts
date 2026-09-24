import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTagOffset, tagName, tagPageHref } from './pagination.ts';

test('tag pages accept only bounded offsets in steps of the page size', () => {
	assert.equal(parseTagOffset(undefined), 0);
	assert.equal(parseTagOffset(''), 0);
	assert.equal(parseTagOffset('50'), 50);
	assert.equal(parseTagOffset('1000000'), 1_000_000);
	for (const bad of ['-50', '25', '1e3', 'abc', '1000050', '9999950', ['0', '50']]) assert.equal(parseTagOffset(bad), null, String(bad));
});

test('page links stay on the list and stop where the API stops', () => {
	assert.equal(tagPageHref('/work/tags', 0), '/work/tags');
	assert.equal(tagPageHref('/work/tags', 100), '/work/tags?offset=100');
	assert.equal(tagPageHref('/work/tags', null), null);
	assert.equal(tagPageHref('/work/tags', 1_000_050), null);
});

test('tag names are trimmed and bounded like the API', () => {
	assert.equal(tagName('  Production '), 'Production');
	assert.deepEqual(tagName('   '), { error: 'Give the tag a name.' });
	assert.deepEqual(tagName('x'.repeat(61)), { error: 'Keep the tag name to 60 characters.' });
	assert.deepEqual(tagName(null), { error: 'Give the tag a name.' });
});
