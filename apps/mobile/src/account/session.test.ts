import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StorageUnreadable } from './contracts.ts';
import { isStoredSession, parseOrganisationId, parseStoredSession, serialiseSession } from './session.ts';

const userId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const token = `sess_${'Ab-_9'.repeat(8)}${'x'.repeat(3)}`;
const expiresAt = '2030-10-01T08:30:00.000Z';
const valid = { token, expiresAt, userId };

const unreadable = (run: () => unknown, label: string) => assert.throws(run, (error: unknown) => {
	assert.ok(error instanceof StorageUnreadable, label);
	assert.equal(error.message, 'The saved sign-in on this device could not be read.', label);
	return true;
}, label);

test('a stored session round-trips exactly, as a frozen copy holding only its three fields', () => {
	assert.equal(token.length, 48);
	const raw = serialiseSession(valid);
	assert.deepEqual(JSON.parse(raw), valid);
	const parsed = parseStoredSession(raw);
	assert.deepEqual(parsed, valid);
	assert.ok(Object.isFrozen(parsed));
	// The schema is exact, the encoding is not: the same fields reordered, re-spaced or escaped differently are the same
	// session, so a harmless change in how the value is written never strands a saved sign-in.
	for (const other of [JSON.stringify({ userId, expiresAt, token }), `${raw} `, ` ${raw}`, JSON.stringify(valid, null, 1), raw.replace('sess_', 'sess\\u005f')])
		assert.deepEqual(parseStoredSession(other), valid, 'equivalent JSON');
	// An expired session is well formed: expiry is the caller's decision.
	assert.deepEqual(parseStoredSession(JSON.stringify({ ...valid, expiresAt: '2001-01-01T00:00:00.000Z' })).expiresAt, '2001-01-01T00:00:00.000Z');
});

test('anything outside the exact session schema is unreadable, and the failure never repeats the value', () => {
	const refused: [string, unknown][] = [
		['not JSON', 'sess_not json'], ['empty', ''], ['null', null], ['string', token], ['array', [valid]], ['number', 1],
		['missing token', { expiresAt, userId }], ['missing expiry', { token, userId }], ['missing user', { token, expiresAt }],
		['extra field', { ...valid, organisationId: userId }], ['prototype key', JSON.parse(`{"__proto__":{"a":1},"token":"${token}","expiresAt":"${expiresAt}","userId":"${userId}"}`)],
		['token prefix', { ...valid, token: `sesx_${token.slice(5)}` }], ['token short', { ...valid, token: token.slice(0, -1) }],
		['token long', { ...valid, token: `${token}A` }], ['token alphabet', { ...valid, token: `${token.slice(0, -1)}=` }],
		['token not a string', { ...valid, token: 42 }],
		['upper-case user', { ...valid, userId: userId.toUpperCase() }], ['braced user', { ...valid, userId: `{${userId}}` }],
		['user without dashes', { ...valid, userId: userId.replaceAll('-', '') }], ['user padded', { ...valid, userId: ` ${userId}` }],
		['date only', { ...valid, expiresAt: '2030-10-01' }], ['no milliseconds', { ...valid, expiresAt: '2030-10-01T08:30:00Z' }],
		['offset', { ...valid, expiresAt: '2030-10-01T08:30:00.000+00:00' }], ['impossible day', { ...valid, expiresAt: '2030-02-30T00:00:00.000Z' }],
		['impossible hour', { ...valid, expiresAt: '2030-10-01T24:00:00.000Z' }], ['epoch number', { ...valid, expiresAt: 1917246600000 }]
	];
	for (const [label, value] of refused) {
		const raw = typeof value === 'string' ? value : JSON.stringify(value);
		unreadable(() => parseStoredSession(raw), label);
		if (typeof value === 'object') assert.equal(isStoredSession(value), false, label);
		try { parseStoredSession(raw); } catch (error) { assert.ok(!String((error as Error).stack).includes(token), label); }
	}
	assert.equal(isStoredSession(Object.assign(Object.create({ inherited: true }), valid)), false, 'a non-plain object');
});

test('an organisation choice is exactly a canonical lower-case UUID', () => {
	assert.equal(parseOrganisationId(userId), userId);
	for (const raw of ['', userId.toUpperCase(), `${userId} `, `"${userId}"`, userId.slice(1), 'null', '../session'])
		unreadable(() => parseOrganisationId(raw), JSON.stringify(raw));
});
