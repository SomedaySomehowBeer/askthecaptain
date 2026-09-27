import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, parseEnded } from './revoke-classify.ts';

const unknown = { kind: 'unknown' };

test('parseEnded: only ended is read; only a non-negative safe integer counts', () => {
	assert.deepEqual(parseEnded({ ended: 3 }), { kind: 'ended', ended: 3 });
	assert.deepEqual(parseEnded({ ended: 0 }), { kind: 'ended', ended: 0 });
	assert.deepEqual(parseEnded({ ended: 3, sessions: ['a'], token: 'sess_x' }), { kind: 'ended', ended: 3 }, 'extra keys are ignored and never copied');
	for (const body of [undefined, null, 'x', 3, [], {}, { ended: -1 }, { ended: 1.5 }, { ended: 2 ** 53 }, { ended: '3' }, { ended: null }, { ended: Number.NaN }]) {
		assert.deepEqual(parseEnded(body), unknown, String(JSON.stringify(body)));
	}
});

test('classify: each answer the web can see maps to one result; a post-send 401 is the signed-out path', () => {
	assert.deepEqual(classify({ ok: true, body: { ended: 2 } }), { kind: 'ended', ended: 2 });
	assert.deepEqual(classify({ ok: true, body: undefined }), unknown, 'an empty 2xx');
	assert.deepEqual(classify({ ok: true, body: { ended: -1 } }), unknown);
	// A 204 or a non-JSON 2xx makes api() throw a SyntaxError, which the action reports as failed.
	assert.deepEqual(classify({ failed: true }), unknown);
	assert.deepEqual(classify({ ok: false, status: 0, retryAfter: null }), unknown, 'no answer');
	assert.deepEqual(classify({ ok: false, status: 401, retryAfter: null }), { kind: 'signed-out-after-send' });
	assert.deepEqual(classify({ ok: false, status: 429, retryAfter: 20 }), { kind: 'rate-limited', retryAfter: 20 });
	assert.deepEqual(classify({ ok: false, status: 429, retryAfter: null }), { kind: 'rate-limited', retryAfter: null });
	for (const status of [400, 403, 404, 409, 422, 499]) assert.deepEqual(classify({ ok: false, status, retryAfter: null }), { kind: 'refused' }, String(status));
	for (const status of [500, 502, 503, 504, 302, 600]) assert.deepEqual(classify({ ok: false, status, retryAfter: 30 }), unknown, String(status));
});
