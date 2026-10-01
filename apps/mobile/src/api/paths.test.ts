import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiPaths, googleStartPath, nativeStartPath, organisationPath } from './paths.ts';

const id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const me = '0190c0de-0000-7000-8000-000000000001';

test('the fixed paths are the routes the app calls, and the start path is separate', () => {
	assert.deepEqual(apiPaths, {
		pushConfig: '/v1/push/config',
		me: '/v1/me', nativeExchange: '/auth/native/exchange', signOut: '/auth/sign-out', revokeOthers: '/v1/me/sessions/revoke-others',
		passkeyOptions: '/auth/passkey/options', passkeyVerify: '/auth/passkey/verify', passkeys: '/v1/me/passkeys', passkeyRegistrationOptions: '/v1/me/passkeys/options', acceptInvitation: '/v1/invitations/accept'
	});
	assert.equal(nativeStartPath, '/auth/google/start'); assert.equal(googleStartPath, nativeStartPath);
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

test('canonical API instants: exactly toISOString output, nothing looser', async () => {
	const { isCanonicalInstant, isCanonicalUuid } = await import('./paths.ts');
	for (const value of ['2026-09-27T00:00:00.000Z', '1899-12-25T00:00:00.000Z', '2200-01-07T23:59:59.999Z', '2024-02-29T12:30:45.123Z'])
		assert.equal(isCanonicalInstant(value), true, value);
	for (const value of ['2026-09-27T00:00:00Z', '2026-09-27T00:00:00.000+00:00', '2026-09-27T08:00:00.000+08:00', '2026-09-27T00:00:00.000z',
		'2026-09-27 00:00:00.000Z', '2026-02-30T00:00:00.000Z', '2025-02-29T00:00:00.000Z', '2026-09-27T24:00:00.000Z', ' 2026-09-27T00:00:00.000Z',
		'+002026-09-27T00:00:00.000Z', '2026-09-27T00:00:00.0000Z', '', 1_790_000_000_000, null, new Date(0)])
		assert.equal(isCanonicalInstant(value), false, String(value));
	assert.equal(isCanonicalUuid(id), true);
	for (const value of [id.toUpperCase(), `${id} `, '', null, 7]) assert.equal(isCanonicalUuid(value), false, String(value));
});

test('equipment catalogue pages: limit=100 then offset, active only, at API page boundaries', async () => {
	const { equipmentPagePath, equipmentPageSize, maxEquipmentOffset } = await import('./paths.ts');
	assert.equal(equipmentPageSize, 100); assert.equal(maxEquipmentOffset, 1_000_000);
	const scope = { epoch: 'e1', userId: me, organisationId: id };
	assert.equal(equipmentPagePath(scope, 0), `/v1/organisations/${id}/equipment?limit=100&offset=0`);
	assert.equal(equipmentPagePath(scope, 300), `/v1/organisations/${id}/equipment?limit=100&offset=300`);
	assert.equal(equipmentPagePath(scope, 1_000_000), `/v1/organisations/${id}/equipment?limit=100&offset=1000000`);
	const path = equipmentPagePath(scope, 100);
	assert.equal(encodeURI(path), path); assert.ok(!path.includes('archived') && !path.includes('e1'));
	for (const offset of [-100, 50, 1_000_100, 100.5, Number.NaN, Number.POSITIVE_INFINITY, '0' as unknown as number])
		assert.throws(() => equipmentPagePath(scope, offset), (error: unknown) => error instanceof TypeError && !error.message.includes(String(offset)), String(offset));
	for (const organisationId of ['', id.toUpperCase(), `${id}?archived=true`])
		assert.throws(() => equipmentPagePath({ userId: me, organisationId }, 0), TypeError);
	assert.throws(() => equipmentPagePath(null as never, 0), TypeError);
});

test('occupancy path: one equipment, exact canonical window, fixed key order, the API maximum rows', async () => {
	const { occupancyPath } = await import('./paths.ts');
	const scope = { epoch: 'e1', userId: me, organisationId: id };
	const eid = '0190c0de-0000-7000-8000-00000000e001';
	const from = '2026-08-31T16:00:00.000Z', to = '2026-09-28T16:00:00.000Z';
	const path = occupancyPath(scope, eid, { from, to });
	assert.equal(path, `/v1/organisations/${id}/equipment/${eid}/reservations?from=${from}&to=${to}&limit=200`);
	assert.equal(encodeURI(path), path, 'no value needs encoding: the transport compares the response URL exactly');
	assert.ok(!path.includes('e1&') && !path.includes('offset'));
	// A range chunk (with its civil dates) satisfies the window structurally; only the instants are used.
	assert.equal(occupancyPath(scope, eid, { from, to, fromDate: '2026-09-01', toDate: '2026-09-29' } as never), path);
	// The API's bounds: a 93-day window at most, and 1900 ≤ from < to < 2200.
	assert.ok(occupancyPath(scope, eid, { from: '2026-01-01T00:00:00.000Z', to: '2026-04-04T00:00:00.000Z' }));
	assert.ok(occupancyPath(scope, eid, { from: '1900-01-01T00:00:00.000Z', to: '1900-01-29T00:00:00.000Z' }));
	assert.ok(occupancyPath(scope, eid, { from: '2199-12-01T00:00:00.000Z', to: '2199-12-31T23:59:59.999Z' }));
	const secretish = 'sess_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
	for (const [bad, window] of [
		[eid.toUpperCase(), { from, to }], ['not-a-uuid', { from, to }], [`${eid}/x`, { from, to }], [secretish, { from, to }],
		[eid, { from: '2026-08-31T16:00:00Z', to }], [eid, { from, to: '2026-09-29T00:00:00.000+08:00' }], [eid, { from: to, to: from }],
		[eid, { from, to: from }], [eid, { from: '2026-01-01T00:00:00.000Z', to: '2026-04-04T00:00:00.001Z' }],
		[eid, { from: '1899-12-31T23:59:59.999Z', to: '1900-01-10T00:00:00.000Z' }], [eid, { from: '2199-12-20T00:00:00.000Z', to: '2200-01-01T00:00:00.000Z' }],
		[eid, null], [eid, { from: secretish, to }]
	] as [string, never][]) {
		assert.throws(() => occupancyPath(scope, bad, window), (error: unknown) => error instanceof TypeError && !error.message.includes(bad) && !error.message.includes(secretish), bad);
	}
	assert.throws(() => occupancyPath({ userId: me, organisationId: 'x' }, eid, { from, to }), TypeError);
	assert.throws(() => occupancyPath(null as never, eid, { from, to }), TypeError);
});
