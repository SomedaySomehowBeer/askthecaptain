import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from './api.ts';
import { callbackFailure, callbackOutcome, nativeCallback, nativeStepUp, nativeTarget } from './native-handoff.ts';

const app = 'https://app.example.test';
/** URL objects have no own enumerable properties, so deep equality would pass for any two; compare hrefs. */
const shown = (outcome: ReturnType<typeof callbackOutcome>) => ({ ...outcome, location: String(outcome.location) });
const code = `nh_${'A'.repeat(21)}-_${'b'.repeat(20)}`;
const attempt = `${'c'.repeat(42)}_`;

test('a handoff goes only to the fixed app callback, carrying exactly the code and the attempt', () => {
	const target = nativeTarget({ nativeHandoff: code, attempt });
	assert.equal(target, `app.askthecaptain.dev:/auth/callback?code=${code}&attempt=${attempt}`);
	const url = new URL(target!);
	assert.equal(url.protocol, 'app.askthecaptain.dev:'); assert.equal(url.host, ''); assert.equal(url.pathname, '/auth/callback');
	assert.deepEqual([...url.searchParams.keys()], ['code', 'attempt']);
	assert.equal(nativeCallback, 'app.askthecaptain.dev:/auth/callback');
	// Extra fields in the API's answer never reach the URL.
	assert.equal(nativeTarget({ nativeHandoff: code, attempt, returnTo: '/work', redirect: 'https://evil.test', token: 'sess_x' }), target);
});

test('anything but a well-formed handoff code and attempt yields no app target', () => {
	const bad: unknown[] = [
		null, undefined, 'nh_x', {}, { nativeHandoff: code }, { attempt },
		{ nativeHandoff: `x_${code.slice(3)}`, attempt }, { nativeHandoff: `${code}A`, attempt }, { nativeHandoff: code.slice(0, -1), attempt },
		{ nativeHandoff: `${code.slice(0, -1)}=`, attempt }, { nativeHandoff: `${code.slice(0, -1)}&`, attempt },
		{ nativeHandoff: code, attempt: `${attempt}A` }, { nativeHandoff: code, attempt: attempt.slice(1) }, { nativeHandoff: code, attempt: `${attempt.slice(1)}#` },
		{ nativeHandoff: code, attempt: 42 }, { nativeHandoff: [code], attempt }, { nativeHandoff: `sess_${'a'.repeat(43)}`, attempt }
	];
	for (const answer of bad) assert.equal(nativeTarget(answer), null, JSON.stringify(answer));
});

test('the callback sends a handoff to the app without a cookie, and a malformed one to a failed sign-in', () => {
	assert.deepEqual(shown(callbackOutcome({ nativeHandoff: code, attempt }, app)), { kind: 'native', location: nativeTarget({ nativeHandoff: code, attempt }) });
	const failed = callbackOutcome({ nativeHandoff: 'nh_short', attempt }, app);
	assert.deepEqual(shown(failed), { kind: 'redirect', location: `${app}/sign-in?error=exchange_failed` });
	for (const outcome of [callbackOutcome({ nativeHandoff: code, attempt }, app), failed]) assert.ok(!('token' in outcome), 'no session cookie on a native answer');
});

test('a step-up is marked native only when the API marked it; the web step-up is unchanged', () => {
	assert.deepEqual(shown(callbackOutcome({ stepUp: true, token: 'pks_abc', returnTo: '/work' }, app)), { kind: 'redirect', location: `${app}/auth/passkey?token=pks_abc` });
	assert.deepEqual(shown(callbackOutcome({ stepUp: true, native: true, token: 'pks_abc', returnTo: '/work' }, app)),
		{ kind: 'redirect', location: `${app}/auth/passkey?token=pks_abc&native=1` });
});

test('a web session answer sets the cookie and returns to a checked path on this app, as before', () => {
	const now = Date.parse('2030-01-01T00:00:00Z');
	assert.deepEqual(shown(callbackOutcome({ token: 'sess_abc', expiresAt: '2030-01-31T00:00:00Z', returnTo: '/work?owner=all' }, app, now)),
		{ kind: 'session', location: `${app}/work?owner=all`, token: 'sess_abc', maxAgeSeconds: 30 * 24 * 60 * 60 });
	assert.deepEqual(shown(callbackOutcome({ token: 'sess_abc', expiresAt: '2030-01-01T00:00:10Z', returnTo: '//evil.test' }, app, now)),
		{ kind: 'session', location: `${app}/`, token: 'sess_abc', maxAgeSeconds: 60 });
});

test('a refused exchange says why: disabled mobile sign-in, an expired link, or an unanswered service', () => {
	assert.equal(callbackFailure(new ApiError(401, 'native_sign_in_disabled', 'Mobile sign-in is not available.', null)), 'native_sign_in_disabled');
	assert.equal(callbackFailure(new ApiError(401, 'unauthorised', 'sign-in link is invalid or expired', null)), 'request_invalid');
	for (const caught of [new ApiError(0, 'offline', 'x', null), new ApiError(500, 'internal', 'x', null), new ApiError(429, 'rate_limited', 'x', null), new TypeError('x')])
		assert.equal(callbackFailure(caught), 'exchange_failed');
});

test('the passkey page is a mobile step-up only for exactly native=1', () => {
	assert.equal(nativeStepUp('1'), true);
	for (const value of [undefined, '', '0', 'true', 'yes', ' 1', ['1'], ['1', '1'], 1, true]) assert.equal(nativeStepUp(value), false, JSON.stringify(value));
});
