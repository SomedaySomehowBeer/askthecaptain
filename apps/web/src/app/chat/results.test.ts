import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, retryAfterSeconds } from '../../lib/api.ts';
import { toReadFailure, toWriteFailure } from './results.ts';

const refusal = (status: number, code: string, retryAfter: number | null = null) => new ApiError(status, code, `API says ${code}`, 'req-1', retryAfter);

test('Retry-After is read as whole seconds only', () => {
	assert.equal(retryAfterSeconds('7'), 7);
	assert.equal(retryAfterSeconds(' 12 '), 12);
	assert.equal(retryAfterSeconds(null), null);
	assert.equal(retryAfterSeconds('Wed, 21 Oct 2026 07:28:00 GMT'), null);
	assert.equal(retryAfterSeconds('1.5'), null);
	assert.equal(retryAfterSeconds('-3'), null);
});

test('a write that may have happened is uncertain; a refusal says nothing changed', () => {
	for (const error of [new ApiError(0, 'offline', 'x', null), refusal(500, 'error'), refusal(503, 'error'), new Error('boom'), 'odd']) {
		assert.equal(toWriteFailure(error).kind, 'uncertain');
	}
	assert.equal(toWriteFailure(refusal(401, 'unauthorised')).kind, 'signed-out');
	assert.equal(toWriteFailure(refusal(404, 'not_found')).kind, 'gone');
	const idTaken = toWriteFailure(refusal(409, 'conversation_id_unavailable'));
	assert.equal(idTaken.kind, 'id-unavailable');
	assert.equal(toWriteFailure(refusal(409, 'message_id_unavailable')).kind, 'id-unavailable');
	const limit = toWriteFailure(refusal(409, 'participant_limit'));
	assert.equal(limit.kind, 'refused');
	assert.equal(limit.kind === 'refused' && limit.code, 'participant_limit');
	assert.match(limit.error, /up to 50 people/);
	const unknown = toWriteFailure(refusal(400, 'something_new'));
	assert.equal(unknown.kind === 'refused' && unknown.error, 'API says something_new');
	assert.equal(unknown.requestId, 'req-1');
});

test('a stale write carries the current state it was given', () => {
	const current = { revision: 4 };
	const stale = toWriteFailure(refusal(409, 'stale_revision'), current);
	assert.equal(stale.kind, 'stale');
	assert.deepEqual(stale.kind === 'stale' && stale.current, current);
	const unread = toWriteFailure(refusal(409, 'stale_revision'));
	assert.equal(unread.kind === 'stale' && unread.current, null);
});

test('429 is not processed: the wait is the header, 60 without one, and never more than 300', () => {
	const seven = toWriteFailure(refusal(429, 'rate_limited', 7));
	assert.equal(seven.kind, 'rate-limited');
	assert.equal(seven.retryAfter, 7);
	assert.match(seven.error, /7 seconds/);
	assert.equal(toWriteFailure(refusal(429, 'rate_limited')).retryAfter, 60);
	assert.equal(toWriteFailure(refusal(429, 'rate_limited', 3_600)).retryAfter, 300);
	assert.equal(toWriteFailure(refusal(429, 'rate_limited', 0)).retryAfter, 1);
	assert.equal(toReadFailure(refusal(429, 'rate_limited', 9)).retryAfter, 9);
	for (const other of [toWriteFailure(new Error('x')), toWriteFailure(refusal(404, 'nf')), toWriteFailure(refusal(400, 'bad'))]) assert.equal(other.retryAfter, null);
});

test('a read failure is gone, signed out, rate limited, or unreadable with the API’s words', () => {
	assert.equal(toReadFailure(refusal(404, 'not_found')).kind, 'gone');
	assert.equal(toReadFailure(refusal(401, 'unauthorised')).kind, 'signed-out');
	const cursor = toReadFailure(refusal(400, 'invalid_request'));
	assert.equal(cursor.kind, 'unreadable');
	assert.equal(cursor.error, 'API says invalid_request');
	assert.equal(toReadFailure(refusal(503, 'error')).kind, 'unreadable');
	assert.equal(toReadFailure(new Error('x')).kind, 'unreadable');
});
