import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiPaths, nativeStartPath, organisationPath } from './paths.ts';

const id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

test('the fixed paths are the routes the app calls, and the start path is separate', () => {
	assert.deepEqual(apiPaths, { me: '/v1/me', nativeExchange: '/auth/native/exchange', signOut: '/auth/sign-out' });
	assert.equal(nativeStartPath, '/auth/google/start');
	assert.ok(!(Object.values(apiPaths) as string[]).includes(nativeStartPath), 'the client never requests the start');
});

test('organisation paths: the organisation itself, and each segment kept inside its own path segment', () => {
	assert.equal(organisationPath(id), `/v1/organisations/${id}`);
	assert.equal(organisationPath(id, 'members'), `/v1/organisations/${id}/members`);
	assert.equal(organisationPath(id, 'views', 'a b'), `/v1/organisations/${id}/views/a%20b`);
	for (const [segment, encoded] of [['a/b', 'a%2Fb'], ['a?b=1', 'a%3Fb%3D1'], ['a#b', 'a%23b'], ['%2e%2e', '%252e%252e'], ['..%2F', '..%252F'], ['\\x', '%5Cx']]) {
		const path = organisationPath(id, segment!);
		assert.equal(path, `/v1/organisations/${id}/${encoded}`, segment);
		assert.ok(!path.includes('?') && !path.includes('#'), segment);
		assert.equal(path.split('/').length, 5, `${segment} stays one segment`);
	}
});

test('organisation paths refuse a non-canonical ID and empty, dot or overlong segments, without repeating the value', () => {
	const secretish = 'sess_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
	for (const bad of ['', 'not-a-uuid', id.toUpperCase(), `${id} `, ` ${id}`, `${id}/x`, `{${id}}`, id.replaceAll('-', ''), secretish, 42 as unknown as string]) {
		assert.throws(() => organisationPath(bad), (error: unknown) => error instanceof TypeError && !error.message.includes(String(bad).trim() || '\u0000'), String(bad));
	}
	for (const bad of ['', '.', '..', 'a'.repeat(201), secretish.repeat(5), 7 as unknown as string]) {
		assert.throws(() => organisationPath(id, 'ok', bad), (error: unknown) => error instanceof TypeError && !error.message.includes(String(bad) || '\u0000'), String(bad).slice(0, 20));
	}
	assert.equal(organisationPath(id, 'a'.repeat(200)).length, `/v1/organisations/${id}/`.length + 200);
});
