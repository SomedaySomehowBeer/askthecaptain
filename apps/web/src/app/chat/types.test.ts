import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isClientId, normaliseBody, normaliseTitle, unreadLabel } from './types.ts';

test('unread is a per-conversation marker: nothing at zero, the number to 50, then "50+" at the API cap', () => {
	assert.equal(unreadLabel(0), null);
	assert.equal(unreadLabel(-1), null);
	assert.equal(unreadLabel(1), '1');
	assert.equal(unreadLabel(50), '50');
	assert.equal(unreadLabel(51), '50+');
});

test('a message body follows the API rule: trimmed, 1–4,000 code points, at most 16 KB', () => {
	assert.equal(normaliseBody('  hello \n'), 'hello');
	assert.ok(typeof normaliseBody('   ') === 'object');
	assert.equal(normaliseBody('😀'.repeat(4000)), '😀'.repeat(4000)); // 4,000 code points, 16,000 bytes
	assert.ok(typeof normaliseBody('a'.repeat(4001)) === 'object');
	assert.ok(typeof normaliseBody('€'.repeat(4000)) === 'string'); // 12,000 bytes
	assert.ok(typeof normaliseBody('𐍈'.repeat(4000) + 'a') === 'object');
});

test('a title is trimmed and 1–80 characters; client ids are non-nil UUIDs', () => {
	assert.equal(normaliseTitle('  Packaging  '), 'Packaging');
	assert.ok(typeof normaliseTitle('') === 'object');
	assert.ok(typeof normaliseTitle('x'.repeat(81)) === 'object');
	assert.equal(isClientId('3f2504e0-4f89-41d3-9a0c-0305e82c3301'), true);
	assert.equal(isClientId('00000000-0000-0000-0000-000000000000'), false);
	assert.equal(isClientId('nope'), false);
});
