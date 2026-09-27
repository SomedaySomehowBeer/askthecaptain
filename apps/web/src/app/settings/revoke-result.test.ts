import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkResult, revokeCopy, revokeResultText, type RevokeResult } from './revoke-result.ts';

const unknown = { kind: 'unknown' };

test('checkResult: every allowed shape passes unchanged', () => {
	const valid: RevokeResult[] = [
		{ kind: 'ended', ended: 0 }, { kind: 'ended', ended: 1 }, { kind: 'ended', ended: 12 },
		{ kind: 'not-sent', reason: 'signed-out' }, { kind: 'not-sent', reason: 'unavailable' },
		{ kind: 'rate-limited', retryAfter: 20 }, { kind: 'rate-limited', retryAfter: 0 }, { kind: 'rate-limited', retryAfter: null },
		{ kind: 'refused' }, { kind: 'unknown' }
	];
	for (const result of valid) assert.deepEqual(checkResult(JSON.parse(JSON.stringify(result))), result, JSON.stringify(result));
});

test('checkResult: anything else, including an extra key, is unknown', () => {
	const invalid: unknown[] = [
		undefined, null, 'x', 3, true, [], [{ kind: 'ended', ended: 1 }], new Date(0),
		{}, { kind: 'nope' }, { ended: 1 },
		{ kind: 'ended', ended: 1, token: 'sess_x' }, { kind: 'ended' }, { kind: 'ended', ended: -1 }, { kind: 'ended', ended: 1.5 },
		{ kind: 'ended', ended: 2 ** 53 }, { kind: 'ended', ended: '1' }, { kind: 'ended', ended: Number.NaN },
		{ kind: 'not-sent', reason: 'other' }, { kind: 'not-sent' }, { kind: 'not-sent', reason: 'signed-out', extra: 1 },
		{ kind: 'rate-limited' }, { kind: 'rate-limited', retryAfter: -1 }, { kind: 'rate-limited', retryAfter: 1.5 }, { kind: 'rate-limited', retryAfter: '5' },
		{ kind: 'refused', status: 403 }, { kind: 'refused', message: 'from the API' }
	];
	for (const value of invalid) assert.deepEqual(checkResult(value), unknown, String(JSON.stringify(value)));
});

test('the wording: exact for every result, grammatical plurals, and a wait only when the server gave one', () => {
	const cases: [RevokeResult, string[]][] = [
		[{ kind: 'ended', ended: 1 }, ['1 other active session ended.', revokeCopy.stillVisible]],
		[{ kind: 'ended', ended: 2 }, ['2 other active sessions ended.', revokeCopy.stillVisible]],
		[{ kind: 'ended', ended: 0 }, ['No other active sessions were ended.']],
		[{ kind: 'not-sent', reason: 'signed-out' }, ['Your session has ended. Sign in again; nothing was sent.']],
		[{ kind: 'not-sent', reason: 'unavailable' }, ['Captain could not reach its service to check your session, so nothing was sent. Your sign-in has been kept; try again in a moment.']],
		[{ kind: 'rate-limited', retryAfter: 1 }, ['Too many attempts. Try again in 1 second.']],
		[{ kind: 'rate-limited', retryAfter: 20 }, ['Too many attempts. Try again in 20 seconds.']],
		[{ kind: 'rate-limited', retryAfter: null }, ['Too many attempts. Try again later.']],
		[{ kind: 'refused' }, ['Captain couldn’t sign out your other sessions.']],
		[{ kind: 'unknown' }, ['Captain couldn’t confirm whether your other sessions were ended. It’s safe to try again.']]
	];
	for (const [result, lines] of cases) assert.deepEqual(revokeResultText(result), lines, JSON.stringify(result));
	assert.equal(revokeCopy.stillVisible, 'Anything already open on another screen stays visible until that screen next checks with Captain. Sign-ins already in progress, and new sign-ins, can still start new sessions.');
	assert.equal(revokeCopy.confirm, 'Sign out of Captain in every other browser and app where you’re signed in, including on phones? This browser stays signed in.');
});

test('the wording never claims that nothing changed when that is not known, and never carries a token', () => {
	for (const result of [{ kind: 'refused' }, { kind: 'unknown' }, { kind: 'rate-limited', retryAfter: 5 }, { kind: 'rate-limited', retryAfter: null }] as RevokeResult[]) {
		assert.doesNotMatch(revokeResultText(result).join(' '), /nothing|no change/i, result.kind);
	}
	assert.doesNotMatch(JSON.stringify(revokeCopy), /sess_/);
});
