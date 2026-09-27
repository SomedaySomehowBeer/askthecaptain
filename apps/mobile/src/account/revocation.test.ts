import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	admit, idleRevocation, parseRevoked, resultOf, samePerson, sendingRevocation, settledRevocation, slowRevocation, unknownResult
} from './revocation.ts';

const userId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const wait = Object.freeze({ until: 20_000, about: new Date(20_000).toISOString() });
const waitOf = (seconds: number) => Object.freeze({ until: seconds * 1000, about: new Date(seconds * 1000).toISOString() });

test('person scopes: equal only with the same epoch and person; no scope is never equal', () => {
	assert.equal(samePerson({ epoch: 'a1', userId }, { epoch: 'a1', userId }), true);
	assert.equal(samePerson({ epoch: 'a1', userId }, { epoch: 'a2', userId }), false, 'ABA: a new sign-in as the same person');
	assert.equal(samePerson({ epoch: 'a1', userId }, { epoch: 'a1', userId: 'other' }), false);
	assert.equal(samePerson(null, null), false);
	assert.equal(samePerson(null, { epoch: 'a1', userId }), false);
});

test('parse: exactly { ended } with a non-negative safe integer; anything else throws (the client reports it as unavailable)', () => {
	assert.deepEqual(parseRevoked({ ended: 0 }), { ended: 0 });
	assert.deepEqual(parseRevoked({ ended: 3 }), { ended: 3 });
	assert.deepEqual(parseRevoked({ ended: Number.MAX_SAFE_INTEGER }), { ended: Number.MAX_SAFE_INTEGER });
	for (const value of [{ ended: -1 }, { ended: 1.5 }, { ended: 2 ** 53 }, { ended: Number.NaN }, { ended: Infinity }, { ended: '2' }, { ended: null }, {}, { ended: 1, extra: 1 }, { count: 1 }, null, undefined, 1, 'x', [1], [{ ended: 1 }]]) {
		assert.throws(() => parseRevoked(value), TypeError, JSON.stringify(value) ?? String(value));
	}
	assert.throws(() => parseRevoked({ ended: -1, token: 'sess_x' }), (error: unknown) => error instanceof TypeError && !error.message.includes('sess_'), 'the message never repeats the body');
});

test('admit: in flight refuses; a wait refuses until exactly its end; otherwise a send may go', () => {
	assert.equal(admit(idleRevocation, 0), null);
	assert.deepEqual(admit(sendingRevocation, 0), { kind: 'in-flight' });
	const waited = settledRevocation({ kind: 'unknown', status: 429, wait, seconds: 20 });
	assert.deepEqual(admit(waited, 19_999), { kind: 'waiting', wait });
	assert.equal(admit(waited, 20_000), null, 'at exactly the wait, it may');
});

test('views: frozen; sending clears the last result (C4); slow flips once and only while in flight; settling clears slow', () => {
	for (const view of [idleRevocation, sendingRevocation, slowRevocation(sendingRevocation), settledRevocation(unknownResult)]) assert.ok(Object.isFrozen(view));
	assert.deepEqual(sendingRevocation, { inFlight: true, slow: false, wait: null, last: null });
	const slow = slowRevocation(sendingRevocation);
	assert.deepEqual(slow, { inFlight: true, slow: true, wait: null, last: null });
	assert.equal(slowRevocation(slow), slow, 'already slow: the same object, so no change');
	assert.equal(slowRevocation(idleRevocation), idleRevocation, 'not in flight: never slow');
	const done = settledRevocation({ kind: 'ok', ended: 2 });
	assert.deepEqual(done, { inFlight: false, slow: false, wait: null, last: { kind: 'ok', ended: 2 } });
	assert.equal(slowRevocation(done), done, 'a late tick after settling changes nothing');
	assert.deepEqual(settledRevocation({ kind: 'refused', status: 403 }).wait, null);
	assert.deepEqual(settledRevocation({ kind: 'unknown', status: 503, wait, seconds: 20 }).wait, wait, 'a 5xx with Retry-After keeps its wait');
});

test('results: the status is kept (C2); a 401 is for the caller to end the session; no server text is carried', () => {
	assert.deepEqual(resultOf({ ok: true, value: { ended: 2 } }, waitOf), { kind: 'ok', ended: 2 });
	assert.equal(resultOf({ ok: false, kind: 'unauthorised' }, waitOf), 'unauthorised');
	assert.deepEqual(resultOf({ ok: false, kind: 'refused', status: 404, code: 'not_found' }, waitOf), { kind: 'refused', status: 404 }, 'no error code carried');
	assert.deepEqual(resultOf({ ok: false, kind: 'unavailable', status: 429, retryAfter: 20 }, waitOf), { kind: 'unknown', status: 429, wait: waitOf(20), seconds: 20 });
	assert.deepEqual(resultOf({ ok: false, kind: 'unavailable', status: 429 }, waitOf), { kind: 'unknown', status: 429, wait: null, seconds: null });
	assert.deepEqual(resultOf({ ok: false, kind: 'unavailable', status: 0 }, waitOf), { kind: 'unknown', status: 0, wait: null, seconds: null });
	assert.deepEqual(unknownResult, { kind: 'unknown', status: 0, wait: null, seconds: null });
});
