import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from './api.ts';
import { safeReturn, sessionFailure, unavailableHref } from './session-state.ts';

test('only a confirmed 401 signs a person out; every other failure keeps the session', () => {
	assert.equal(sessionFailure(new ApiError(401, 'unauthenticated', 'Sign in again.', null)), 'signed-out');
	for (const status of [0, 400, 403, 404, 408, 429, 500, 502, 503, 504])
		assert.equal(sessionFailure(new ApiError(status, 'x', 'x', null)), 'unavailable', String(status));
	assert.equal(sessionFailure(new TypeError('fetch failed')), 'unavailable');
	assert.equal(sessionFailure(undefined), 'unavailable');
});

test('return paths stay on this site', () => {
	assert.equal(safeReturn('/resources/equipment?date=2030-10-01'), '/resources/equipment?date=2030-10-01');
	for (const bad of ['https://evil.test', '//evil.test', '/\\evil.test', '/\t/evil.test', '/\n/evil.test', '/%0A', '', undefined, null])
		assert.equal(safeReturn(bad), bad === '/%0A' ? '/%0A' : '/work', JSON.stringify(bad));
	assert.equal(unavailableHref('/work?owner=all&tagId=a'), '/unavailable?return_to=%2Fwork%3Fowner%3Dall%26tagId%3Da');
	assert.equal(unavailableHref('https://evil.test'), '/unavailable?return_to=%2Fwork');
});
