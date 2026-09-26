import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from './api.ts';
import { appReturnUrl, safeReturn, sessionFailure, unavailableHref } from './session-state.ts';

test('only a confirmed 401 signs a person out; every other failure keeps the session', () => {
	assert.equal(sessionFailure(new ApiError(401, 'unauthenticated', 'Sign in again.', null)), 'signed-out');
	for (const status of [0, 400, 403, 404, 408, 429, 500, 502, 503, 504])
		assert.equal(sessionFailure(new ApiError(status, 'x', 'x', null)), 'unavailable', String(status));
	assert.equal(sessionFailure(new TypeError('fetch failed')), 'unavailable');
	assert.equal(sessionFailure(undefined), 'unavailable');
});

/** Same-origin paths are kept exactly, with their query and fragment (the API's table in return-path.test.ts). */
const kept = [
	'/', '/work', '/resources/equipment?date=2030-10-01', '/chat?filter=unread&linked=false&team=abc',
	'/chat/new?link=task%3A3f2504e0-4f89-41d3-9a0c-0305e82c3301', '/work/tasks/abc#comment-1',
	'/search?q=https://evil.test', '/@evil.test', '/%2F%2Fevil.test', '/%5Cevil.test', '/%0A', '/a/../b'
];
/** Anything that is not a same-origin path, or that a browser could turn into one on another origin. */
const refused: unknown[] = [
	'', 'work', ' /work', 'https://evil.test', 'http:/evil.test', 'javascript:alert(1)',
	'//evil.test', '///evil.test',
	'/\\evil.test', '/\\/evil.test', '\\\\evil.test', '/work\\..\\..\\evil',
	'/\t/evil.test', '/\n/evil.test', '/\r\n/evil.test', '/\u0000evil', '/\u007f', '/work\u001b',
	'/..//evil.test', '/.//evil.test', '/a/..//evil.test', '/%2e%2e//evil.test', '/a/%2E%2E//evil.test',
	`/${'a'.repeat(2048)}`,
	undefined, null, 42, ['/work'], ['/work', '/chat']
];

test('return paths stay on this site: same-origin paths are kept exactly', () => {
	for (const value of kept) assert.equal(safeReturn(value), value, JSON.stringify(value));
	for (const value of kept) assert.equal(safeReturn(value, '/'), value, JSON.stringify(value));
});

test('return paths stay on this site: every escape falls back to the default', () => {
	for (const value of refused) assert.equal(safeReturn(value), '/work', JSON.stringify(value));
	for (const value of refused) assert.equal(safeReturn(value, '/'), '/', JSON.stringify(value));
	assert.equal(unavailableHref('/work?owner=all&tagId=a'), '/unavailable?return_to=%2Fwork%3Fowner%3Dall%26tagId%3Da');
	assert.equal(unavailableHref('https://evil.test'), '/unavailable?return_to=%2Fwork');
	assert.equal(unavailableHref('/\\evil.test'), '/unavailable?return_to=%2Fwork');
});

test('the sign-in callback URL is always on the app, whatever the API answered', () => {
	const app = 'https://app.example.test';
	for (const value of kept) {
		const url = appReturnUrl(value, app);
		assert.equal(url.origin, app, JSON.stringify(value));
		assert.equal(url.href, new URL(value, app).href, JSON.stringify(value));
	}
	for (const value of refused) assert.equal(appReturnUrl(value, app).href, `${app}/`, JSON.stringify(value));
});
