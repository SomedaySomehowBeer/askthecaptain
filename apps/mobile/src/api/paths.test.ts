import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiPaths, maxWorkPages, myWorkPath, nativeStartPath, organisationPath, stockPath, workPageSize } from './paths.ts';

const id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

test('stock requests active items across locations without query or user-controlled segments', () => {
	assert.equal(stockPath({ userId: id, organisationId: id }), `/v1/organisations/${id}/stock`);
	for (const organisationId of ['', id.toUpperCase(), `${id}?includeArchived=1`, '../stock']) assert.throws(() => stockPath({ userId: id, organisationId }), TypeError);
});

test('the fixed paths are the routes the app calls, and the start path is separate', () => {
	assert.deepEqual(apiPaths, { me: '/v1/me', nativeExchange: '/auth/native/exchange', signOut: '/auth/sign-out', revokeOthers: '/v1/me/sessions/revoke-others' });
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

const me = '0190c0de-0000-7000-8000-000000000001';

test('my work path: the web’s My work query, in a fixed order, for each page within the cap', () => {
	assert.equal(workPageSize, 50); assert.equal(maxWorkPages, 10);
	assert.equal(myWorkPath({ userId: me, organisationId: id }, 0), `/v1/organisations/${id}/tasks?ownerId=${me}&status=open&offset=0&limit=50`);
	assert.equal(myWorkPath({ userId: me, organisationId: id }, 450), `/v1/organisations/${id}/tasks?ownerId=${me}&status=open&offset=450&limit=50`);
	// A read scope with its epoch (and anything else) is accepted; only the two IDs are used.
	const scope = { epoch: 'e1', userId: me, organisationId: id };
	assert.equal(myWorkPath(scope, 50), `/v1/organisations/${id}/tasks?ownerId=${me}&status=open&offset=50&limit=50`);
	for (let page = 0; page < maxWorkPages; page += 1) {
		const path = myWorkPath(scope, page * workPageSize);
		assert.equal(encodeURI(path), path, 'nothing in it needs encoding');
		assert.ok(!path.includes('e1'), 'the epoch is never part of a path');
	}
});

test('my work path refuses a bad ID, an off-page or out-of-cap offset, without repeating the value', () => {
	const secretish = 'sess_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
	for (const bad of ['', 'x', me.toUpperCase(), `${me}&status=done`, `${me} `, secretish, 7 as unknown as string, undefined as unknown as string]) {
		assert.throws(() => myWorkPath({ userId: bad, organisationId: id }, 0), (error: unknown) => error instanceof TypeError && !error.message.includes(String(bad) || '\u0000'), String(bad));
		assert.throws(() => myWorkPath({ userId: me, organisationId: bad }, 0), (error: unknown) => error instanceof TypeError && !error.message.includes(String(bad) || '\u0000'), String(bad));
	}
	for (const offset of [-50, 1, 49, 25.5, 500, 1_000_000, Number.NaN, Number.POSITIVE_INFINITY, '0' as unknown as number]) {
		assert.throws(() => myWorkPath({ userId: me, organisationId: id }, offset), (error: unknown) => error instanceof TypeError && !error.message.includes(String(offset)), String(offset));
	}
	assert.throws(() => myWorkPath(null as never, 0), TypeError);
});

test('All tasks explicitly requests open status for all owners using the same bounded paging rules', async () => {
 const { workListPath } = await import('./paths.ts');
 const scope = { userId: me, organisationId: id };
 for (let offset = 0; offset <= 450; offset += 50) {
  assert.equal(workListPath(scope, 'all', offset), `/v1/organisations/${id}/tasks?status=open&offset=${offset}&limit=50`);
  assert.equal(workListPath(scope, 'mine', offset), myWorkPath(scope, offset));
 }
 for (const view of ['', 'all&status=done', null, undefined])
  assert.throws(() => workListPath(scope, view as never, 0), TypeError);
 for (const offset of [-50, 49, 500, Infinity]) assert.throws(() => workListPath(scope, 'all', offset), TypeError);
 assert.throws(() => workListPath({ ...scope, userId: 'invalid' }, 'all', 0), TypeError);
 assert.throws(() => workListPath({ ...scope, organisationId: 'invalid' }, 'all', 0), TypeError);
});
