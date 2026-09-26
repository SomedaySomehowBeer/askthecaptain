import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeReturnPath } from './return-path.ts';

/** Same-origin paths are kept exactly, including their query and fragment. */
const kept = [
	'/',
	'/work',
	'/chat?filter=unread&linked=false&team=abc',
	'/chat/new?link=task%3A3f2504e0-4f89-41d3-9a0c-0305e82c3301',
	'/work/tasks/abc#comment-1',
	'/search?q=https://evil.test', // another URL inside the query is only data
	'/@evil.test', // a path segment, not userinfo
	'/%2F%2Fevil.test', // encoded slashes stay inside the path
	'/%5Cevil.test', // an encoded backslash stays inside the path
	'/a/../b' // dot segments that stay on a normal path
];

/** Anything that is not a same-origin path, or that a browser could turn into one on another origin. */
const refused: unknown[] = [
	'', 'work', ' /work', 'https://evil.test', 'http:/evil.test', 'javascript:alert(1)',
	'//evil.test', '///evil.test',
	'/\\evil.test', '/\\/evil.test', '\\\\evil.test', '/work\\..\\..\\evil',
	'/\t/evil.test', '/\n/evil.test', '/\r\n/evil.test', '/\u0000evil', '/\u007f', '/work\u001b',
	'/..//evil.test', '/.//evil.test', '/a/..//evil.test', '/%2e%2e//evil.test', '/a/%2E%2E//evil.test',
	`/${'a'.repeat(2048)}`,
	undefined, null, 42, ['/work'], { toString: () => '/work' }
];

test('return paths: same-origin paths are kept exactly', () => {
	for (const value of kept) assert.equal(safeReturnPath(value), value, JSON.stringify(value));
});

test('return paths: other origins, backslashes, control characters and dot-segment escapes are refused', () => {
	for (const value of refused) assert.equal(safeReturnPath(value), null, JSON.stringify(value));
});

test('return paths: every kept path resolves on the app itself, even against a real origin', () => {
	for (const value of kept) assert.equal(new URL(value, 'https://app.example.test').origin, 'https://app.example.test', value);
});
