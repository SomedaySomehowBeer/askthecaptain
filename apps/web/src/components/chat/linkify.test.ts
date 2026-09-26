import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linkify } from './linkify.ts';

test('web addresses become links; everything else stays text', () => {
	assert.deepEqual(linkify('See https://example.com/a?b=1 for details.'), [
		{ kind: 'text', text: 'See ' },
		{ kind: 'link', text: 'https://example.com/a?b=1', href: 'https://example.com/a?b=1' },
		{ kind: 'text', text: ' for details.' },
	]);
	assert.deepEqual(linkify('No links here'), [{ kind: 'text', text: 'No links here' }]);
	assert.deepEqual(linkify(''), []);
});

test('sentence punctuation and unmatched brackets end the link', () => {
	assert.deepEqual(linkify('(see http://example.com/x).').map(p => p.text), ['(see ', 'http://example.com/x', ').']);
	assert.deepEqual(linkify('https://en.wikipedia.org/wiki/Ale_(beer), ok').map(p => p.text), ['https://en.wikipedia.org/wiki/Ale_(beer)', ', ok']);
	assert.deepEqual(linkify('"https://example.com"').map(p => p.text), ['"', 'https://example.com', '"']);
});

test('only http and https are ever links', () => {
	for (const body of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'ftp://example.com/file', 'mailto:a@example.com'])
		assert.ok(linkify(body).every(p => p.kind === 'text'), body);
	assert.equal(linkify('HTTPS://EXAMPLE.COM/Path')[0]!.kind, 'link');
});

test('markup is kept as text for the renderer to escape', () => {
	assert.deepEqual(linkify('<script>x</script> https://example.com'), [
		{ kind: 'text', text: '<script>x</script> ' },
		{ kind: 'link', text: 'https://example.com', href: 'https://example.com/' },
	]);
});
